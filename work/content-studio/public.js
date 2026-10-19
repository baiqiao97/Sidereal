// ============================================================
// public.js：公共资料仓库只读预览。同一页面承载两种模式：
// /public 显示全部公共列表；/public?id=编号 显示单条资料详情。
// 只调用公开接口 /api/publications、/api/publications/编号 与公共附件下载地址；
// 不创建/读取 IndexedDB 或 localStorage，不访问任何草稿接口，
// 不上传内容、不解析执行附件。
// 登录状态仅用于“保存到我的草稿”按钮：读取 /api/auth/me 失败
// 不影响公共列表/详情的读取、搜索与下载，匿名浏览始终可用。
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
    const headingElement = document.getElementById("publicHeading");
    const filtersElement = document.getElementById("publicFilters");
    const returnLink = document.getElementById("publicReturnLink");
    const detailNote = document.getElementById("publicDetailNote");
    const linkStatus = document.getElementById("publicLinkStatus");

    // 模式判定：URL 带 id 参数（哪怕值为空）即详情模式；
    // 详情编号只允许 [A-Za-z0-9_-]{1,100}，为空/无效按“资料不可用”处理并直接拒绝请求，
    // 绝不回退成完整列表
    const DETAIL_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
    const urlParams = new URLSearchParams(window.location.search);
    const hasIdParam = urlParams.has("id");
    const rawDetailId = hasIdParam ? urlParams.get("id") : null;
    const detailId = rawDetailId !== null && DETAIL_ID_PATTERN.test(rawDetailId) ? rawDetailId : null;
    const isDetail = hasIdParam;
    const detailInvalid = hasIdParam && detailId === null;

    // 已成功加载的公共快照数组；加载失败时保留上一次成功的数据，绝不假装仓库为空；
    // 首次成功前为 null。详情模式始终只含一条（复用 render/卡片/导入逻辑）。
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

    // 链接复制结果专用状态行（role=status），与导入状态互不干扰
    function setLinkStatus(text, isError) {
        if (!linkStatus) return;
        linkStatus.textContent = text;
        linkStatus.classList.toggle("status-error", Boolean(isError));
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
            pub.file ? pub.file.name : "",
            pub.publisher || ""
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

    // 一条公共资料的只读卡片：标题/类型/简介/发布版本与时间/附件/详情链接/
    // 复制链接按钮/导入按钮；所有用户文本用 textContent 填充，不会被解析执行
    function buildCard(pub) {
        const card = document.createElement("article");
        card.className = "draft-card";

        const heading = document.createElement("h3");
        heading.textContent = pub.title;
        card.appendChild(heading);

        const categoryLine = document.createElement("p");
        categoryLine.textContent = "类型：" + (CATEGORY_TEXT[pub.category] || pub.category);
        card.appendChild(categoryLine);

        // 发布者=当前分享账号的用户名；旧数据未认领时显示占位文案
        const publisherLine = document.createElement("p");
        publisherLine.className = "public-publisher";
        publisherLine.textContent = "发布者：" + (pub.publisher || "未认领资料");
        card.appendChild(publisherLine);

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

        // 详情页链接：固定本机地址 /public?id=编号，编号做地址编码。
        // 详情模式下的卡片不需要指向自身的链接，只在列表卡片显示。
        if (!isDetail) {
            const detailLine = document.createElement("p");
            const detailLink = document.createElement("a");
            detailLink.className = "public-link public-detail";
            detailLink.href = "/public?id=" + encodeURIComponent(pub.id);
            detailLink.textContent = "查看详情";
            detailLine.appendChild(detailLink);
            card.appendChild(detailLine);
        }

        // 复制链接按钮：只把规范化详情地址写入剪贴板，
        // 不导入、不保存、不修改任何数据，也不会在页面加载时自动触发
        const copyLinkLine = document.createElement("p");
        const copyLinkButton = document.createElement("button");
        copyLinkButton.type = "button";
        copyLinkButton.className = "public-copy-link";
        copyLinkButton.textContent = "复制链接";
        copyLinkButton.addEventListener("click", function () {
            handleCopyLink(pub);
        });
        copyLinkLine.appendChild(copyLinkButton);
        card.appendChild(copyLinkLine);

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

    // 过滤只在已加载数组上进行，不追加请求；详情模式只渲染已加载的那一条
    function render() {
        if (!publications) return;
        // 详情模式隐藏搜索/类型筛选，不参与过滤
        const keyword = isDetail ? "" : searchInput.value.trim().toLowerCase();
        const category = isDetail ? "" : categorySelect.value;
        const visible = publications.filter(function (pub) {
            return matchesFilters(pub, keyword, category);
        });

        if (isDetail) {
            countLine.hidden = true;
        } else {
            countLine.textContent = "公共仓库共 " + publications.length +
                " 份资料，当前显示 " + visible.length + " 份。";
        }
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

    // 复制详情链接：规范化绝对地址 = location.origin + "/public?id=" + 编号（编码），
    // 不带任何额外参数/凭据/哈希。只操作剪贴板，不导入/保存/修改任何数据。
    // 剪贴板写入被拒绝或不可用时，退回 window.prompt 手动复制；
    // prompt 本身也加 try/catch，任何失败都不会产生未处理的 Promise 拒绝。
    async function handleCopyLink(pub) {
        const url = window.location.origin + "/public?id=" + encodeURIComponent(pub.id);
        setLinkStatus("正在复制链接…", false);
        try {
            await navigator.clipboard.writeText(url);
            setLinkStatus("链接已复制，指向当前已发布版本；目前仅在这台电脑上可访问。", false);
        } catch (error) {
            setLinkStatus("自动复制未完成，请手动复制链接；目前仅在这台电脑上可访问。", true);
            try {
                window.prompt("请复制此链接（指向当前已发布版本，目前仅本机可访问）：", url);
            } catch (promptError) {
                return;
            }
        }
    }

    // 详情模式下的“不可用”渲染：清空旧卡片与旧数据，留下可读说明，
    // 返回列表链接与刷新按钮保持在页面上可用；绝不显示已撤回资料的旧内容
    function clearDetail(message) {
        publications = null;
        listElement.textContent = "";
        const unavailable = document.createElement("p");
        unavailable.className = "empty-hint";
        unavailable.textContent = message;
        listElement.appendChild(unavailable);
    }

    // 首次加载与手动刷新共用：
    // - 登录检查与公共读取各自独立 try/catch，auth 失败不会把公共数据当空库；
    // - 详情模式：编号为空/无效时不发任何请求，直接显示不可用提示；
    //   服务端确认 400/404（编号无效/已撤回）时清空详情并给出可读提示；
    // - 加载期间复制按钮禁用（避免账号检查和复制并行），完成后由重绘可靠恢复
    async function refreshAll() {
        if (refreshing) return;
        refreshing = true;
        refreshButton.disabled = true;
        disableImportButtons(true);
        setImportStatus("", false);
        // 详情模式（含编号为空/无效）：只走详情加载，绝不回退成完整列表；
        // 编号无效时 loadDetail 直接显示不可用提示，不发任何请求
        setStatus(hasIdParam ? "正在加载公共资料详情…" : "正在从本机服务加载公共列表…");
        try {
            await Promise.all([checkAuth(), hasIdParam ? loadDetail() : loadPublications()]);
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

    // 详情加载：只请求 /api/publications/编号 这一条，不拉全列表。
    // - 编号为空/格式无效：不发请求，直接显示不可用提示，且绝不回退成列表；
    // - 服务端 400/404（编号无效或资料已撤回/不可用）：清空旧详情数组与卡片，
    //   显示可读的不可用提示，返回与刷新按钮仍然可用；
    // - 网络/5xx 等其他错误：保留上一次成功加载的详情（不假装空库），
    //   显示明确的失败说明。
    async function loadDetail() {
        if (detailInvalid) {
            clearDetail("这条公共资料详情不可用：详情地址缺少有效的资料编号" +
                "（编号为空或格式不正确），因此没有发起任何请求。" +
                "可点“查看全部公共资料”返回公开列表重新选择。");
            setStatus("公共资料详情不可用：详情地址中的资料编号无效，请求已被跳过。", true);
            return;
        }
        try {
            const item = await serverApi.getPublication(detailId);
            publications = [item];
            render();
            setStatus("已加载公共资料详情：当前为已发布的第 " + item.version + " 版。");
        } catch (error) {
            if (error && (error.status === 400 || error.status === 404)) {
                clearDetail("这条公共资料当前不可用：可能已撤回发布，或链接指向的资料编号无效。" +
                    "公共链接始终只指向已发布的版本，撤回后无法查看。" +
                    "可点“查看全部公共资料”返回公开列表重新选择。");
                setStatus("公共资料详情不可用：" +
                    (error && error.message ? error.message : "本机服务确认资料当前不可用") + "。", true);
            } else {
                setStatus("加载公共资料详情失败：" +
                    (error && error.message ? error.message : "本机服务不可用") +
                    "。当前显示的详情已保留，未被当作空数据；请确认本机服务已启动后再点“刷新资料”。", true);
            }
        }
    }

    // 服务端 401/403（如跨标签账号变化）触发：清空当前用户与已复制标记，
    // 引导重新登录；公共列表/详情原样保留
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
        if (publications && !isDetail) render();
    });
    categorySelect.addEventListener("change", function () {
        if (publications && !isDetail) render();
    });
    refreshButton.addEventListener("click", refreshAll);

    // 详情模式的静态界面调整（只做一次）：标题、隐藏筛选与计数、刷新文案、
    // 返回链接与详情说明；列表模式保持原有外观与行为不变
    if (hasIdParam) {
        document.title = "公共资料详情";
        if (headingElement) headingElement.textContent = "公共资料详情";
        if (filtersElement) filtersElement.hidden = true;
        if (countLine) countLine.hidden = true;
        refreshButton.textContent = "刷新资料";
        if (returnLink) returnLink.hidden = false;
        if (detailNote) detailNote.hidden = false;
    }

    // 打开页面：登录检查与公开读取并行、互不阻塞；匿名浏览/下载保持可用
    updateAccountStatus();
    refreshAll();
})();
