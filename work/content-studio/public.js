// ============================================================
// public.js：公共资料仓库只读预览。
// 只调用公开接口 /api/publications 与公共附件下载地址；
// 不创建/读取 IndexedDB 或 localStorage，不访问任何草稿接口，
// 不上传内容、不解析执行附件。
// 登录状态仅用于“保存到我的草稿”按钮：读取 /api/auth/me 失败
// 不影响公共列表的读取、搜索与下载，匿名浏览始终可用。
// ============================================================
(function () {
    // 类型代码到中文展示的对照（与工作台一致）
    const CATEGORY_TEXT = { law: "法律法规", notes: "笔记", questions: "题库" };
    const EMPTY_FILE_TEXT = "未提供附件";

    const searchInput = document.getElementById("publicSearch");
    const categorySelect = document.getElementById("publicCategory");
    const refreshButton = document.getElementById("publicRefresh");
    const listElement = document.getElementById("publicList");
    const countLine = document.getElementById("publicCount");
    const statusLine = document.getElementById("publicStatus");
    const accountStatus = document.getElementById("publicAccountStatus");
    const loginLink = document.getElementById("publicLoginLink");
    const draftsLink = document.getElementById("publicDraftsLink");
    const importStatusLine = document.getElementById("publicImportStatus");

    // 已成功加载的公共快照数组；加载失败时保留上一次成功的数据，绝不假装仓库为空；
    // 首次成功前为 null
    let publications = null;

    // 当前登录用户（仅内存，来自 /api/auth/me；不读写 localStorage/IndexedDB）
    let currentUserId = null;
    let currentUsername = "";
    // 本页会话内已成功复制过的 id:version 集合；切账号/登录失效时清空，不持久化
    const importedKeys = new Set();
    // 互斥标记：refresh 为列表加载中，importing 为正在复制（同一时刻仅一个复制请求）
    let refreshing = false;
    let importing = false;

    function setStatus(text, isError) {
        statusLine.textContent = text;
        statusLine.classList.toggle("status-error", Boolean(isError));
    }

    function setImportStatus(text, isError) {
        if (!importStatusLine) return;
        importStatusLine.textContent = text;
        importStatusLine.classList.toggle("status-error", Boolean(isError));
    }

    // publishedAt 是 ISO 时间，直接 new Date 展示；解析不了就原样显示
    function formatPublishedTime(iso) {
        const date = new Date(iso);
        return isNaN(date.getTime()) ? String(iso) : date.toLocaleString("zh-CN");
    }

    function matchesFilters(pub, keyword, category) {
        if (category && pub.category !== category) return false;
        if (!keyword) return true;
        const haystack = [
            pub.title,
            pub.description || "",
            pub.file ? pub.file.name : ""
        ].join("\n").toLowerCase();
        return haystack.indexOf(keyword) !== -1;
    }

    // 复制按钮禁用规则：未登录、列表刷新中、正在复制、本页会话已成功复制过
    function isImportAvailable() {
        return Boolean(currentUserId) && !refreshing && !importing;
    }

    // 把当前 DOM 里所有复制按钮按状态统一置灰（重绘后的按钮在 buildCard 中遵守同一状态）
    function disableImportButtons(disabled) {
        listElement.querySelectorAll("button.public-import").forEach(function (button) {
            if (disabled || !importedKeys.has(button.dataset.importKey || "")) {
                button.disabled = true;
            }
        });
    }

    // 统一登录状态提示；所有用户文案均用 textContent
    function updateAccountStatus() {
        if (accountStatus) {
            accountStatus.textContent = currentUserId
                ? "已登录：" + currentUsername + "。保存的副本可独立编辑，不会自动发布。"
                : "到工作台选择“本机服务”登录后，可保存公共资料为自己的草稿。";
        }
        if (loginLink) loginLink.hidden = Boolean(currentUserId);
        if (draftsLink) draftsLink.hidden = !currentUserId;
    }

    // 独立于公共列表的登录状态检查；失败只影响复制按钮与账号提示，
    // 不妨碍公共列表读取/搜索/下载，也不把匿名当错误拦下
    async function checkAuth() {
        let nextUser = null;
        try {
            const payload = await serverApi.authMe();
            nextUser = payload && payload.user ? payload.user : null;
        } catch (error) {
            nextUser = null;
            setImportStatus("登录状态确认失败：" +
                (error && error.message ? error.message : "本机服务不可用") +
                "。公共浏览与下载不受影响；如需保存草稿，请到工作台登录后重试。", true);
        }
        const previousUserId = currentUserId;
        currentUserId = nextUser && nextUser.id != null ? String(nextUser.id) : null;
        currentUsername = nextUser && nextUser.username ? String(nextUser.username) : "";
        // 直接采用 /api/auth/me 的结果，绝不绕过它用其他账号提交
        serverApi.setUser(nextUser);
        // 账号变化（含登出/失效）时清空本页已复制标记，避免跨账号误标
        if (previousUserId !== currentUserId) importedKeys.clear();
        updateAccountStatus();
        if (publications) render();
    }

    // 一条公共资料的只读卡片：标题/类型/简介/发布版本与时间/附件名；
    // 所有用户文本用 textContent 填充，不会被解析执行
    function buildCard(pub) {
        const card = document.createElement("article");
        card.className = "draft-card";

        const heading = document.createElement("h3");
        heading.textContent = pub.title;
        card.appendChild(heading);

        const categoryLine = document.createElement("p");
        categoryLine.textContent = "类型：" + (CATEGORY_TEXT[pub.category] || pub.category);
        card.appendChild(categoryLine);

        const descriptionLine = document.createElement("p");
        descriptionLine.className = "draft-description";
        descriptionLine.textContent = "简介：" + (pub.description || "未填写简介");
        card.appendChild(descriptionLine);

        const publishedLine = document.createElement("p");
        publishedLine.textContent = "发布：第 " + pub.version + " 版（" + formatPublishedTime(pub.publishedAt) + "）";
        card.appendChild(publishedLine);

        const fileLine = document.createElement("p");
        fileLine.textContent = "附件：" + (pub.file ? pub.file.name : EMPTY_FILE_TEXT);
        card.appendChild(fileLine);

        // 附件用服务返回的 url + download 直接触发下载，不解析不执行附件内容
        if (pub.file && pub.file.url) {
            const downloadLine = document.createElement("p");
            const link = document.createElement("a");
            link.className = "public-link";
            link.href = pub.file.url;
            if (pub.file.name) link.download = pub.file.name;
            link.textContent = "下载附件";
            downloadLine.appendChild(link);
            card.appendChild(downloadLine);
        }

        // “保存到我的草稿”：只提交 id 与 version，复制失败不影响列表本身
        const importLine = document.createElement("p");
        const importButton = document.createElement("button");
        importButton.type = "button";
        importButton.className = "public-import";
        importButton.dataset.importKey = pub.id + ":" + pub.version;
        if (importedKeys.has(importButton.dataset.importKey)) {
            importButton.textContent = "已保存到我的草稿";
            importButton.disabled = true;
        } else {
            importButton.textContent = "保存到我的草稿";
            importButton.disabled = !isImportAvailable();
        }
        importButton.addEventListener("click", function () {
            handleImport(pub, importButton);
        });
        importLine.appendChild(importButton);
        card.appendChild(importLine);

        return card;
    }

    // 过滤只在已加载数组上进行，不追加请求
    function render() {
        if (!publications) return;
        const keyword = searchInput.value.trim().toLowerCase();
        const category = categorySelect.value;
        const visible = publications.filter(function (pub) {
            return matchesFilters(pub, keyword, category);
        });

        countLine.textContent = "公共仓库共 " + publications.length +
            " 份资料，当前显示 " + visible.length + " 份。";
        listElement.textContent = "";

        if (visible.length === 0) {
            const empty = document.createElement("p");
            empty.className = "empty-hint";
            empty.textContent = publications.length === 0
                ? "公共仓库还没有发布任何资料。"
                : "没有符合当前搜索/筛选条件的资料，试试换关键词或类型。";
            listElement.appendChild(empty);
            return;
        }

        visible.forEach(function (pub) {
            listElement.appendChild(buildCard(pub));
        });
    }

    // 复制动作：不重新拉 authMe、不自动重试；同一时刻仅允许一个请求，
    // 期间刷新与其他复制按钮全部禁用；无论成败 finally 恢复按钮；
    // 失败不重建/清空列表，搜索筛选条件原样保留
    async function handleImport(pub, button) {
        if (!currentUserId || refreshing || importing) return;
        importing = true;
        refreshButton.disabled = true;
        disableImportButtons(true);
        setImportStatus("正在保存到我的草稿…", false);
        try {
            await serverApi.importPublication(pub.id, pub.version);
            importedKeys.add(pub.id + ":" + pub.version);
            setImportStatus("已保存到我的草稿：" + pub.title + "（公开第 " + pub.version + " 版）。" +
                "副本可独立编辑，不会自动发布。", false);
        } catch (error) {
            setImportStatus("保存到我的草稿失败：" +
                (error && error.message ? error.message : "本机服务不可用") +
                "。未能确认保存结果时，请先到我的草稿查看，避免重复复制。", true);
        } finally {
            importing = false;
            refreshButton.disabled = false;
            // 重绘恢复按钮状态（已复制的保持“已保存到我的草稿”并禁用）
            if (publications) render();
        }
    }

    // 首次加载与手动刷新共用：
    // - 登录检查与公开列表各自独立 try/catch，auth 失败不会把公共列表当空库；
    // - 列表请求失败显示可读错误并保留上一次成功列表；
    // - 加载期间复制按钮禁用（避免账号检查和复制并行），完成后由重绘可靠恢复
    async function refreshAll() {
        if (refreshing) return;
        refreshing = true;
        refreshButton.disabled = true;
        disableImportButtons(true);
        setImportStatus("", false);
        setStatus("正在从本机服务加载公共列表…");
        try {
            await Promise.all([checkAuth(), loadPublications()]);
        } finally {
            refreshing = false;
            refreshButton.disabled = false;
            if (publications) render();
        }
    }

    async function loadPublications() {
        try {
            const items = await serverApi.listPublications();
            publications = Array.isArray(items) ? items : [];
            render();
            setStatus("公共列表已更新，共 " + publications.length + " 份资料。");
        } catch (error) {
            setStatus("加载公共列表失败：" +
                (error && error.message ? error.message : "本机服务不可用") +
                "。当前显示的列表已保留，未当作空仓库；请确认本机服务已启动后再点“刷新公共列表”。", true);
        }
    }

    // 服务端 401/403（如跨标签账号变化）触发：清空当前用户与已复制标记，
    // 引导重新登录；公共列表原样保留
    window.addEventListener("studio-auth-required", function () {
        currentUserId = null;
        currentUsername = "";
        serverApi.setUser(null);
        importedKeys.clear();
        updateAccountStatus();
        if (publications) render();
        setImportStatus("登录状态已变化，本次保存未能完成。请到工作台重新登录后重试；若对结果有疑问，请先到我的草稿查看，避免重复复制。", true);
    });

    searchInput.addEventListener("input", function () {
        if (publications) render();
    });
    categorySelect.addEventListener("change", function () {
        if (publications) render();
    });
    refreshButton.addEventListener("click", refreshAll);

    // 打开页面：登录检查与公开列表并行、互不阻塞；匿名浏览/下载保持可用
    updateAccountStatus();
    refreshAll();
})();
