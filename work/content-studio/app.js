// ============================================================
// Sidereal 内容工作台 第二～五阶段：本地保存（IndexedDB，可选本机服务）、
// 资料列表/搜索/筛选、版本历史与恢复。
// 边界：不上传云端、不跨设备同步、不解析附件内容。
// ============================================================

// ---- 页面元素引用（数据来源：用户在本页表单中填写的内容）----
const form = document.getElementById("materialForm");
const titleInput = document.getElementById("materialTitle");
const descriptionInput = form.elements.description;
const categorySelect = form.elements.category;
const fileInput = document.getElementById("fileInput");

const reviewSection = document.getElementById("reviewSection");
const reviewTitle = document.getElementById("reviewTitle");
const reviewCategory = document.getElementById("reviewCategory");
const reviewDescription = document.getElementById("reviewDescription");
const reviewFile = document.getElementById("reviewFile");
const draftError = document.getElementById("draftError");

// 保存相关按钮与状态行
const saveDraftButton = document.getElementById("saveDraftButton");
const newDraftButton = document.getElementById("newDraftButton");
const removeAttachmentButton = document.getElementById("removeAttachment");
const attachmentStatus = document.getElementById("attachmentStatus");
const editingStatus = document.getElementById("editingStatus");
const storageStatus = document.getElementById("storageStatus");
// 保存位置选择框（browser=当前浏览器 / server=本机服务）
const storageModeSelect = document.getElementById("storageMode");

// 列表区域
const librarySection = document.getElementById("librarySection");
const draftList = document.getElementById("draftList");
const draftCount = document.getElementById("draftCount");
const draftSearch = document.getElementById("draftSearch");
const categoryFilter = document.getElementById("categoryFilter");

// 版本历史区域
const historySection = document.getElementById("historySection");
const historyList = document.getElementById("historyList");
const historyLabel = document.getElementById("historyDraftLabel");

// 公共仓库预览入口（index 内；仅本机服务模式显示）
const publicSection = document.getElementById("publicSection");

// 资料备份与恢复（index 内；仅本机服务模式显示）
const backupSection = document.getElementById("backupSection");
const backupInput = document.getElementById("backupInput");
const restoreBackupButton = document.getElementById("restoreBackupButton");

// 资料回收站（index 内；仅本机服务模式且已登录时显示）
const trashSection = document.getElementById("trashSection");
const trashRefresh = document.getElementById("trashRefresh");
const trashStatus = document.getElementById("trashStatus");
const trashList = document.getElementById("trashList");

// 账户资料用量（index 内；仅本机服务模式且已登录时显示，只读）
const usageSection = document.getElementById("usageSection");
const usageSummary = document.getElementById("usageSummary");
const usageUpdated = document.getElementById("usageUpdated");
const usageRefresh = document.getElementById("usageRefresh");
const usageStatus = document.getElementById("usageStatus");

// ---- 固定文案 ----
// 下拉框选项值到中文名称的对照表，展示时用这份数据翻译
const CATEGORY_TEXT = {
    law: "法律法规",
    notes: "笔记",
    questions: "题库"
};
const EMPTY_DESCRIPTION_TEXT = "未填写简介";
const EMPTY_FILE_TEXT = "未选择文件";

// ============================================================
// IndexedDB 本地数据库
// 数据库固定名 sidereal-content-studio，版本 1；
// 对象仓库 drafts，主键 id（我们自己生成的字符串）。
// 每条记录字段：id / title / description / category / file /
// createdAt / updatedAt / versions（版本快照数组，见下）。
// versions：每次成功保存 push 一条完整快照
// { version, savedAt, title, description, category, file }，
// version 从 1 递增；恢复旧版本 = 复制旧快照成新版本。
// ============================================================
const DB_NAME = "sidereal-content-studio";
const DB_VERSION = 1;
const DRAFT_STORE = "drafts";

// 页面打开时连接所选保存位置，后续读写共用这个 Promise
let dbPromise = null;
// 数据库不可用（打开/读取失败等）时为 true，保存等按钮保持禁用
let storageFailed = false;

// 保存/恢复/删除共用的操作防重标记：一次只放行一个写库操作
let operationBusy = false;

// 当前正在编辑的资料 id；null 表示“新建”状态
let editingId = null;
// 当前附件：浏览器保存的对象含真实 Blob，本机服务返回的对象含下载地址；无附件为 null。
// 新选 File 只包装一次，之后直接沿用对应保存位置的附件对象。
let currentAttachment = null;
// 编辑时点过“移除附件”后为 true，保存时不再沿用旧附件（新选过文件则不受影响）
let attachmentRemoved = false;

// ---- 保存位置（阶段五）：browser=当前浏览器，server=本机服务 ----
const STORAGE_MODE_KEY = "sidereal-content-studio-location";
// 记住的位置选择；只存/读这个字符串，不搬动、不删除任何资料
let storageMode = "browser";
// 账号控制器（仅 server 模式连接存储时创建一次）；canWrite() 表示当前已登录可写
let accounts = null;
// 登录状态变化后，丢弃之前发出的列表请求，避免退出或换号后重显旧资料。
let accountEpoch = 0;
// 当前登录账户（仅保存在内存里）；用于确认文案与恢复前守卫，不本地持久化，
// 也不据此自动重新登录（换号时恢复如未过期交给 epoch 守卫丢弃结果）
let currentAccount = null;

// 当前是否应禁用写操作：存储失败，或 server 模式下尚未登录
function writesDisabled() {
    return storageFailed || (storageMode === "server" && (!accounts || !accounts.canWrite()));
}
// 服务器模式下：正在编辑的资料在服务器上的版本号（保存前核对，防跨窗口覆盖）
let editingRevision = null;
// 历史面板打开时资料的版本号（恢复前核对，防止覆盖没看到的新版本）
let historyRevision = null;

/** 打开数据库；失败时 reject，由启动代码给用户可见提示并禁用保存 */
function openDatabase() {
    return new Promise(function (resolve, reject) {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = function () {
            // 首次建立：对象仓库 drafts，keyPath=id 表示按对象里的 id 字段定位记录
            if (!request.result.objectStoreNames.contains(DRAFT_STORE)) {
                request.result.createObjectStore(DRAFT_STORE, { keyPath: "id" });
            }
        };
        request.onsuccess = function () { resolve(request.result); };
        request.onerror = function () { reject(request.error); };
        request.onblocked = function () { reject(new Error("数据库被其他页面占用，无法打开")); };
    });
}

/** 连接标记：{kind:"server"} 表示保存到本机服务，否则是 IndexedDB 连接 */
function isServerDb(db) {
    return Boolean(db && db.kind === "server");
}

/** 写入一条资料；服务器模式只上传本次内容并返回最新 DTO，本地以 transaction.oncomplete 为准 */
function putDraft(db, draft) {
    if (isServerDb(db)) return serverApi.put(draft);
    return new Promise(function (resolve, reject) {
        const tx = db.transaction(DRAFT_STORE, "readwrite");
        tx.objectStore(DRAFT_STORE).put(draft);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error("写入被中止")); };
    });
}

/** 读出全部资料；服务器模式直接返回 DTO 列表 */
function getAllDrafts(db) {
    if (isServerDb(db)) return serverApi.list();
    return new Promise(function (resolve, reject) {
        const tx = db.transaction(DRAFT_STORE, "readonly");
        const request = tx.objectStore(DRAFT_STORE).getAll();
        request.onsuccess = function () {
            resolve(request.result || []);
        };
        request.onerror = function () { reject(request.error); };
    });
}

/** 按 id 读一条资料；没有则返回 null（服务器 404 同样视为不存在）。读取错误抛出，不冒充不存在 */
function getDraft(db, id) {
    if (isServerDb(db)) return serverApi.get(id);
    return new Promise(function (resolve, reject) {
        const tx = db.transaction(DRAFT_STORE, "readonly");
        const request = tx.objectStore(DRAFT_STORE).get(id);
        request.onsuccess = function () {
            resolve(request.result || null);
        };
        request.onerror = function () { reject(request.error); };
    });
}

/** 按 id 删除；浏览器模式直接删本地记录，服务器模式改为移入回收站，
 *  第 3 个版本号仅服务器模式用于防并发误删，本地实现忽略 */
function deleteDraftById(db, id, expectedVersion) {
    if (isServerDb(db)) return serverApi.remove(id, expectedVersion);
    return new Promise(function (resolve, reject) {
        const tx = db.transaction(DRAFT_STORE, "readwrite");
        tx.objectStore(DRAFT_STORE).delete(id);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error("删除被中止")); };
    });
}

// ---- 状态提示 ----
// storageStatus 用 role=status，普通信息礼貌播报；
// draftError 用 role=alert，错误立即播报。
function setStorageStatus(text, isError) {
    storageStatus.textContent = text;
    storageStatus.classList.toggle("status-error", Boolean(isError));
}

function showError(message) {
    draftError.textContent = message;
    draftError.hidden = false;
}

function hideError() {
    draftError.hidden = true;
    draftError.textContent = "";
}

/** 页面刚打开：保存等按钮先禁用，等数据库与首次列表读取成功后再启用 */
function setStartupDisabled(disabled) {
    const merged = disabled || writesDisabled();
    saveDraftButton.disabled = merged;
    newDraftButton.disabled = merged;
    removeAttachmentButton.disabled = merged;
    restoreBackupButton.disabled = merged;
    // 备份文件的选择随之禁用：未登录/存储失效/操作锁定期间不允许挑备份
    backupInput.disabled = merged || storageMode !== "server";
    // 回收站刷新同属启动控制：未登录/存储失效/操作锁定期间不允许刷
    trashRefresh.disabled = merged;
    // 用量刷新同属只读操作控制：登录/服务可用后才允许刷
    usageRefresh.disabled = merged;
    // 已渲染的回收站卡片按钮一并控制：认证期间新渲染的卡片不能永久保持禁用
    disableTrashButtons(merged);
}

/** 读库/列表失败的统一停用：不清空、不假装没有数据 */
function disableSaveUi(message) {
    storageFailed = true;
    saveDraftButton.disabled = true;
    newDraftButton.disabled = true;
    removeAttachmentButton.disabled = true;
    restoreBackupButton.disabled = true;
    // 备份文件的选择一并禁用：存储已失效时不允许继续挑选备份文件
    backupInput.disabled = true;
    librarySection.hidden = false;
    const empty = document.createElement("p");
    empty.className = "empty-hint";
    empty.textContent = message;
    draftList.appendChild(empty);
    setStorageStatus(message, true);
}

function formatTime(timestamp) {
    return new Date(timestamp).toLocaleString("zh-CN");
}

// ============================================================
// 核对（保留第一阶段行为：Enter / 提交按钮都触发，
// 校验不过不展示，核对不写库）
// ============================================================
form.addEventListener("submit", function (event) {
    // 取消默认提交，避免页面跳转清空用户已写内容
    event.preventDefault();
    hideError();

    const draft = collectDraft();

    // 标题去掉两端空白后只剩空串，视为无效标题
    if (!draft.title) {
        showError("标题只有空白，无法生成核对结果，请输入有效标题后再提交。");
        return;
    }

    showDraft(draft);
});

// 从表单读取当前内容并归一化（标题、简介 trim，类型翻中文）
function collectDraft() {
    return {
        title: titleInput.value.trim(),
        description: descriptionInput.value.trim(),
        categoryText: CATEGORY_TEXT[categorySelect.value] || categorySelect.value,
        fileName: getCurrentAttachmentName()
    };
}

// 当前附件的取舍规则（核对展示与保存共用）：
// 1) 用户新选了文件 -> 包装成规范 {name, blob:File}（唯一的包装处，不重复套层）；
// 2) 编辑已有资料、未新选、没点过“移除附件” -> 沿用已保存的规范对象本身；
// 3) 其余 -> 无附件
function getCurrentAttachment() {
    const newFile = fileInput.files[0];
    if (newFile) return { name: newFile.name, blob: newFile };
    if (editingId && currentAttachment && !attachmentRemoved) return currentAttachment;
    return null;
}

function getCurrentAttachmentName() {
    const file = getCurrentAttachment();
    return file ? file.name : EMPTY_FILE_TEXT;
}

// 用 textContent 填充，用户输入按普通文字处理，不会被解析执行
function showDraft(draft) {
    reviewTitle.textContent = draft.title;
    reviewCategory.textContent = draft.categoryText;
    reviewDescription.textContent = draft.description === "" ? EMPTY_DESCRIPTION_TEXT : draft.description;
    reviewFile.textContent = draft.fileName;
    reviewSection.hidden = false;
}

// ============================================================
// 保存草稿（阶段二）：真正写 IndexedDB，
// 每次成功保存都新增一条版本快照（阶段四的历史直接用它）
// ============================================================
saveDraftButton.addEventListener("click", async function () {
    if (writesDisabled() || operationBusy) return;
    hideError();
    setStorageStatus("");

    // 保留表单原生 required 校验（reportValidity 弹浏览器提示），
    // 再单独拦截纯空白标题：去掉两端空白后只剩空串视为无效
    if (!form.reportValidity()) return;
    const title = titleInput.value.trim();
    if (!title) {
        showError("标题只有空白，不能保存，请输入有效标题。");
        titleInput.focus();
        return;
    }

    // 操作防重从第一次 await 前开始，finally 里统一释放
    operationBusy = true;
    saveDraftButton.disabled = true;
    newDraftButton.disabled = true;
    try {
        // 编辑已有资料时先读原纪录；读不到说明已删除，停止本次保存
        let existing = null;
        if (editingId) {
            try {
                const db = await dbPromise;
                existing = await getDraft(db, editingId);
            } catch (error) {
                showError("读取原资料失败，未保存。请重试。");
                return;
            }
            if (!existing) {
                showError("要编辑的资料已不存在（可能已被删除），已回到新建状态。");
                editingId = null;
                currentAttachment = null;
                attachmentRemoved = false;
                editingRevision = null;
                saveDraftButton.textContent = "保存草稿";
                updateAttachmentStatus();
                updateEditingStatus();
                return;
            }
        }

        // 附件取舍：新选文件 > 沿用旧附件（未点移除）> 无附件。
        // file 已是规范 {name, blob:真实Blob} 对象，记录与版本快照直接存同一个对象，
        // 不再包一层，保证 blob 始终是真 Blob（下载时 createObjectURL 参数正确）。
        const file = getCurrentAttachment();

        const now = Date.now();
        const description = descriptionInput.value.trim();
        const category = categorySelect.value;

        // 版本快照：复制当前完整内容，历史以此为准
        const newVersions = existing ? existing.versions.slice() : [];
        newVersions.push({
            version: newVersions.length + 1,
            savedAt: now,
            title: title,
            description: description,
            category: category,
            file: file
        });

        const record = {
            id: editingId || generateId(),
            title: title,
            description: description,
            category: category,
            file: file,
            createdAt: existing ? existing.createdAt : now,
            updatedAt: now,
            versions: newVersions
        };

        const db = await dbPromise;

        // 服务器模式：保存前按载入时记住的版本核对；其他窗口已改过就不覆盖
        if (isServerDb(db) && editingId && existing.revision !== editingRevision) {
            showError("这条资料刚被其他窗口修改过，为避免覆盖别人的改动，本次没有保存。请从列表重新打开这条资料再编辑。表单内容未丢弃。");
            return;
        }

        const saved = await putDraft(db, record);

        // ---- 保存成功之后 ----
        const savedId = record.id;
        editingId = savedId;
        if (isServerDb(db)) {
            // 服务器模式：用返回的最新 DTO 校准版本号与当前附件（服务器附件没有 Blob）
            editingRevision = saved ? saved.revision : editingRevision;
            currentAttachment = saved && saved.file ? saved.file : null;
        } else {
            currentAttachment = file;
        }
        attachmentRemoved = false;

        // 保存后清空文件 input（防止下次误把旧文件当成“新选的”），已保存的附件不受影响
        fileInput.value = "";
        updateAttachmentStatus();
        updateEditingStatus();

        setStorageStatus("已保存：" + title + "（第 " + newVersions.length + " 个版本）");

        // 保存后继续编辑同一条：按钮变为“保存修改”，下一次保存更新同一条而非复制
        saveDraftButton.textContent = "保存修改";

        // 重新渲染列表；如果历史正开着且就是这条，也一起刷新
        await renderDrafts();
        if (!historySection.hidden && historyDraftId === savedId) {
            await openHistory(savedId);
        }
    } catch (error) {
        // 失败绝不能冒充成功：表单内容原样保留，让用户重试
        showError("保存失败：" + (error && error.message ? error.message : "数据库写入出错") + "。表单内容未丢弃，请重试。");
        return;
    } finally {
        operationBusy = false;
        saveDraftButton.disabled = writesDisabled();
        newDraftButton.disabled = writesDisabled();
    }
});

// 生成记录 id：时间戳 + 随机串，足够本页区分不同资料
function generateId() {
    return "draft-" + Date.now() + "-" + Math.random().toString(16).slice(2, 10);
}

// ---- 附件/编辑状态展示 ----
function updateAttachmentStatus() {
    const newFile = fileInput.files[0];
    // 有“新选文件”或“已保存的当前附件”才显示移除按钮
    removeAttachmentButton.hidden = !((editingId && currentAttachment) || newFile);

    if (newFile) {
        // 新选的文件优先展示，核对/保存用的也是它（刚点过“移除”也不影响）
        attachmentStatus.textContent = "新选附件：" + newFile.name + "，保存后替换当前附件。";
        attachmentStatus.hidden = false;
    } else if (editingId && currentAttachment) {
        // 编辑中沿用已保存附件；点过“移除附件”则提示已移除
        attachmentStatus.textContent = attachmentRemoved
            ? "已移除当前附件，点保存后生效。"
            : "当前附件：" + currentAttachment.name + "（未新选文件则保存时保留它）";
        attachmentStatus.hidden = false;
    } else {
        attachmentStatus.hidden = true;
        attachmentStatus.textContent = "";
    }
}

function updateEditingStatus() {
    if (editingId) {
        editingStatus.textContent = "正在编辑一条已有资料，点保存会更新同一条，不会复制一条新的。";
        editingStatus.hidden = false;
    } else {
        editingStatus.hidden = true;
        editingStatus.textContent = "";
    }
}

// 新选文件后刷新附件状态，核对/保存使用的就是这个新文件
fileInput.addEventListener("change", function () {
    hideError();
    updateAttachmentStatus();
});

// 移除附件：
// 1) 刚新选了文件 -> 先移除新选的（清空选择，回到“保留已保存附件”）；
// 2) 没有新选文件、编辑已有资料 -> 只标记去掉当前已保存附件，点保存才写库生效
removeAttachmentButton.addEventListener("click", function () {
    if (writesDisabled()) return;
    if (fileInput.files[0]) {
        fileInput.value = "";
    } else if (editingId && currentAttachment) {
        attachmentRemoved = true;
    }
    updateAttachmentStatus();
});

// ============================================================
// 新建资料：重置表单、附件、核对、编辑状态，可另存一条
// ============================================================
/** 清空资料表单/编辑状态/附件/核对/历史；只动界面状态，不删除任何已保存的资料 */
function clearEditor() {
    form.reset();
    fileInput.value = "";
    reviewSection.hidden = true;
    editingId = null;
    currentAttachment = null;
    attachmentRemoved = false;
    editingRevision = null;
    historyRevision = null;
    saveDraftButton.textContent = "保存草稿";
    updateAttachmentStatus();
    updateEditingStatus();
    historySection.hidden = true;
    historyDraftId = null;
}

newDraftButton.addEventListener("click", function () {
    if (writesDisabled()) return;
    hideError();
    setStorageStatus("");
    clearEditor();
    titleInput.focus();
});

// ============================================================
// 资料列表（阶段三）：渲染 + 搜索 + 类型过滤
// 过滤规则：关键字对标题/简介/文件名做大小写不敏感的包含匹配，
// 且类型要一致（选“全部类型”不限制）；两个条件同时生效。
// 按更新时间倒序展示（新的在前）。
// ============================================================
draftSearch.addEventListener("input", renderDrafts);
categoryFilter.addEventListener("change", renderDrafts);

async function renderDrafts() {
    const readEpoch = accountEpoch;
    const drafts = await loadDrafts();
    if (!drafts || readEpoch !== accountEpoch) {
        // 读取失败：现有列表原样保留，绝不假装“没有资料”
        return;
    }
    librarySection.hidden = false;

    const keyword = draftSearch.value.trim().toLowerCase();
    const filter = categoryFilter.value;

    const visible = drafts.filter(function (draft) {
        if (filter && draft.category !== filter) return false;
        if (!keyword) return true;
        const haystack = [
            draft.title,
            draft.description || "",
            draft.file ? draft.file.name : ""
        ].join("\n").toLowerCase();
        return haystack.indexOf(keyword) !== -1;
    });

    // updatedAt 倒序：最近更新的排在前面
    visible.sort(function (a, b) { return b.updatedAt - a.updatedAt; });

    draftCount.textContent = "共 " + drafts.length + " 条资料，当前显示 " + visible.length + " 条。";
    draftList.textContent = "";

    if (visible.length === 0) {
        const empty = document.createElement("p");
        empty.className = "empty-hint";
        empty.textContent = drafts.length === 0
            ? "这里还没有保存的资料。填好表单后点“保存草稿”。"
            : "没有符合当前搜索/筛选条件的资料，试试换关键词或类型。";
        draftList.appendChild(empty);
        return;
    }

    visible.forEach(function (draft) {
        draftList.appendChild(buildDraftCard(draft));
    });
}

/** 读全部资料；失败返回 null（disableSaveUi 内已给出可见错误并禁用保存）。
 *  注意：失败时绝不清空/重绘现有列表，也不冒充“没有资料”。 */
async function loadDrafts() {
    if (storageFailed) return null;
    const readEpoch = accountEpoch;
    try {
        const db = await dbPromise;
        return await getAllDrafts(db);
    } catch (error) {
        if (readEpoch !== accountEpoch) return null;
        // server 模式 401/403：账号控制器已展示重新登录界面，不清空列表、不写 storageFailed
        if (storageMode === "server" && error && (error.status === 401 || error.status === 403)) {
            return null;
        }
        disableSaveUi((storageMode === "server" ? "读取本机服务上的资料失败：" : "读取本地资料失败：") + (error && error.message ? error.message : "读取出错") + "。现有列表未改动，请刷新重试。");
        return null;
    }
}

/** 把一条资料渲染成一张卡片；所有字段用 textContent，附件不解析不执行 */
function buildDraftCard(draft) {
    const card = document.createElement("article");
    card.className = "draft-card";

    const heading = document.createElement("h3");
    heading.textContent = draft.title;
    card.appendChild(heading);

    const categoryLine = document.createElement("p");
    categoryLine.textContent = "类型：" + (CATEGORY_TEXT[draft.category] || draft.category);
    card.appendChild(categoryLine);

    const descriptionLine = document.createElement("p");
    descriptionLine.className = "draft-description";
    descriptionLine.textContent = "简介：" + (draft.description || EMPTY_DESCRIPTION_TEXT);
    card.appendChild(descriptionLine);

    const fileLine = document.createElement("p");
    fileLine.textContent = "附件：" + (draft.file ? draft.file.name : EMPTY_FILE_TEXT);
    card.appendChild(fileLine);

    const timeLine = document.createElement("p");
    timeLine.textContent = "更新时间：" + formatTime(draft.updatedAt);
    card.appendChild(timeLine);

    // 公开状态（仅服务器模式）：未发布 / 已发布第 N 版；草稿版本比已发布版本新则追加提示
    if (storageMode === "server") {
        const publication = draft.publication || null;
        const publicationLine = document.createElement("p");
        if (publication) {
            publicationLine.textContent = "已发布第 " + publication.version + " 版";
            if (typeof draft.revision === "number" && draft.revision > publication.version) {
                publicationLine.textContent += "，草稿有未发布的修改";
            }
        } else {
            publicationLine.textContent = "未发布";
        }
        card.appendChild(publicationLine);
    }

    const actions = document.createElement("p");
    actions.className = "draft-actions";

    const editButton = document.createElement("button");
    editButton.type = "button";
    editButton.textContent = "编辑";
    editButton.addEventListener("click", function () { startEdit(draft.id); });

    const historyButton = document.createElement("button");
    historyButton.type = "button";
    historyButton.textContent = "版本历史";
    historyButton.addEventListener("click", function () { openHistory(draft.id); });

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    // 服务器模式改为移入回收站（可恢复）；浏览器存储仍直接删除
    deleteButton.textContent = storageMode === "server" ? "移入回收站" : "删除";
    deleteButton.addEventListener("click", function () { removeDraft(draft.id); });

    actions.appendChild(editButton);
    actions.appendChild(historyButton);
    actions.appendChild(deleteButton);

    // 仅浏览器模式出现：把这条资料最新一次保存的内容复制为本机服务里一条新草稿
    if (storageMode === "browser") {
        const copyButton = document.createElement("button");
        copyButton.type = "button";
        copyButton.className = "copy-to-server";
        copyButton.textContent = "复制到本机账户";
        copyButton.addEventListener("click", function () { copyBrowserDraftToServer(draft.id); });
        actions.appendChild(copyButton);
    }

    // 发布/撤回按钮（仅服务器模式）；浏览器存储模式绝不出现发布按钮
    if (storageMode === "server") {
        addPublishActions(actions, draft);
    }

    // 仅服务器模式出现：导出这份资料的 .studio-backup 备份文件
    if (storageMode === "server") {
        const exportButton = document.createElement("button");
        exportButton.type = "button";
        exportButton.className = "export-backup";
        exportButton.textContent = "导出备份";
        exportButton.addEventListener("click", function () { exportBackupFile(draft); });
        actions.appendChild(exportButton);
    }

    // 有附件才有下载按钮：浏览器附件用 Blob URL，服务器附件用下载地址
    if (draft.file && (draft.file.blob || draft.file.url)) {
        const downloadButton = document.createElement("button");
        downloadButton.type = "button";
        downloadButton.textContent = "下载附件";
        downloadButton.addEventListener("click", function () { downloadAttachment(draft.file); });
        actions.appendChild(downloadButton);
    }

    card.appendChild(actions);
    return card;
}

// ============================================================
// 公共仓库（server 模式）：发布当前已保存版本 / 撤回发布。
// 两个操作共用 operationBusy，与保存/删除/恢复互斥；
// expected 参数一律取卡片上看到的版本号，不先重读再悄悄提交。
// 成功后才刷新列表和状态行；绝不改动正在编辑的表单/附件/版本状态。
// ============================================================

/** 组装发布相关按钮：未发布→“发布到公共仓库”；
 *  已发布且草稿版本更新→“更新公共版本”；已发布→“撤回发布”。
 *  同一版本已发布过就不再显示发布/更新按钮。 */
function addPublishActions(actions, draft) {
    const publication = draft.publication || null;
    const revision = (typeof draft.revision === "number") ? draft.revision : null;

    if (!publication && revision !== null) {
        const publishButton = document.createElement("button");
        publishButton.type = "button";
        publishButton.textContent = "发布到公共仓库";
        publishButton.addEventListener("click", function () { publishDraft(draft); });
        actions.appendChild(publishButton);
    } else if (publication) {
        if (revision !== null && revision > publication.version) {
            const updateButton = document.createElement("button");
            updateButton.type = "button";
            updateButton.textContent = "更新公共版本";
            updateButton.addEventListener("click", function () { publishDraft(draft); });
            actions.appendChild(updateButton);
        }
        const unpublishButton = document.createElement("button");
        unpublishButton.type = "button";
        unpublishButton.textContent = "撤回发布";
        unpublishButton.addEventListener("click", function () { unpublishDraft(draft); });
        actions.appendChild(unpublishButton);
    }
}

/** 发布：把这条资料卡片上看到的当前已保存版本（draft.revision）推到公共仓库 */
async function publishDraft(draft) {
    if (writesDisabled() || operationBusy) return;
    operationBusy = true;
    saveDraftButton.disabled = true;
    newDraftButton.disabled = true;
    try {
        const expectedVersion = draft.revision;
        const versionNote = typeof expectedVersion === "number"
            ? "当前已保存的第 " + expectedVersion + " 版"
            : "当前已保存的版本";
        const confirmed = window.confirm(
            "确定把“" + draft.title + "”发布到公共仓库吗？只发布列表里" + versionNote +
            "这一版；表单里未保存的修改不会被发布。发布时会展示你的用户名。"
        );
        if (!confirmed) return;
        hideError();
        try {
            const updated = await serverApi.publish(draft.id, expectedVersion);
            const publishedVersion = (updated && updated.publication && typeof updated.publication.version === "number")
                ? updated.publication.version
                : expectedVersion;
            setStorageStatus("已把“" + draft.title + "”的第 " + publishedVersion + " 版发布到公共仓库。");
            await renderDrafts();
        } catch (error) {
            showError("发布失败：" + (error && error.message ? error.message : "本机服务出错") + "。表单内容和资料列表未改动。");
            return;
        }
    } finally {
        operationBusy = false;
        saveDraftButton.disabled = writesDisabled();
        newDraftButton.disabled = writesDisabled();
    }
}

/** 撤回发布：仅从公共仓库移除这一版，草稿与全部版本历史保留 */
async function unpublishDraft(draft) {
    if (writesDisabled() || operationBusy) return;
    operationBusy = true;
    saveDraftButton.disabled = true;
    newDraftButton.disabled = true;
    try {
        const publication = draft.publication || null;
        if (!publication) return;
        const expectedPublishedVersion = publication.version;
        const confirmed = window.confirm(
            "确定撤回“" + draft.title + "”的公共版本（第 " + expectedPublishedVersion +
            " 版）吗？仅从公共仓库移除这一版，草稿和全部版本历史保留。"
        );
        if (!confirmed) return;
        hideError();
        try {
            await serverApi.unpublish(draft.id, expectedPublishedVersion);
            setStorageStatus("已撤回“" + draft.title + "”的公共版本，草稿和历史保留。");
            await renderDrafts();
        } catch (error) {
            showError("撤回失败：" + (error && error.message ? error.message : "本机服务出错") + "。表单内容和资料列表未改动。");
            return;
        }
    } finally {
        operationBusy = false;
        saveDraftButton.disabled = writesDisabled();
        newDraftButton.disabled = writesDisabled();
    }
}

// ============================================================
// 资料回收站（仅服务器模式且已登录）：
// - 列出已移入回收站的资料（含 trashToken），卡片可恢复或永久删除；
// - 恢复不打开/不改当前编辑器；永久删除需确认且不可恢复；
// - 每次渲染同时记下账号纪元和递增读序，晚到的旧响应不重绘；
// - 失败保留现有列表，只显示可读提示；401/403 由账号控制器接管。
// - 回收站读取失败不影响保存：绝不因此写 storageFailed。
// ============================================================

// 递增的读序号：每次发起回收站读取 ++；晚到的旧响应发现序号变了就丢弃
let trashReadSeq = 0;

function setTrashStatus(text, isError) {
    trashStatus.textContent = text;
    trashStatus.classList.toggle("status-error", Boolean(isError));
}

/** 登出/需要重新登录时隐藏并清空回收站；读序 +1 让晚到的列表响应作废 */
function hideTrash() {
    trashReadSeq += 1;
    trashSection.hidden = true;
    trashList.textContent = "";
    trashStatus.textContent = "";
    trashStatus.classList.remove("status-error");
    trashRefresh.disabled = true;
}

/** 操作期间禁用已渲染的回收站按钮；恢复时尊重 writesDisabled */
function disableTrashButtons(disabled) {
    const merged = disabled || writesDisabled();
    trashList.querySelectorAll("button").forEach(function (button) {
        button.disabled = merged;
    });
}

/** 读取并渲染回收站；仅登录后的服务器模式可见，其余模式一律不请求 */
async function renderTrash() {
    if (storageMode !== "server" || !accounts || !accounts.canWrite()) return;
    // 同时固定纪元与读序：登出/换号或更新的请求都能让旧响应作废
    const readEpoch = accountEpoch;
    const readSeq = ++trashReadSeq;
    // 先显示区域再发请求：首次 500 时错误提示和刷新按钮也可见；失败保留现有列表
    trashSection.hidden = false;
    let items;
    try {
        items = await serverApi.listTrash();
    } catch (error) {
        if (readEpoch !== accountEpoch || readSeq !== trashReadSeq) return;
        // 登录态由账号控制器处理；其余错误保留现有列表，只显示可读提示
        if (error && (error.status === 401 || error.status === 403)) return;
        setTrashStatus("读取回收站失败：" + (error && error.message ? error.message : "本机服务出错") + "。现有列表未改动，请稍后点“刷新回收站”重试。", true);
        return;
    }
    if (readEpoch !== accountEpoch || readSeq !== trashReadSeq) return;

    trashStatus.textContent = "";
    trashStatus.classList.remove("status-error");
    trashList.textContent = "";

    if (!items || items.length === 0) {
        const empty = document.createElement("p");
        empty.className = "empty-hint";
        empty.textContent = "回收站是空的。移入回收站的资料会出现在这里。";
        trashList.appendChild(empty);
        return;
    }

    items.forEach(function (item) {
        trashList.appendChild(buildTrashCard(item));
    });
    // 若渲染发生在某个写操作期间，新卡片按钮同样先禁用
    disableTrashButtons(operationBusy);
}

/** 把一条回收站记录渲染成卡片；全部 textContent，token 闭包捕获后直接用于写操作 */
function buildTrashCard(item) {
    const card = document.createElement("article");
    card.className = "draft-card";

    const heading = document.createElement("h3");
    heading.textContent = item.title;
    card.appendChild(heading);

    const deletionLine = document.createElement("p");
    deletionLine.textContent = "删除时间：" + formatTime(new Date(item.deletedAt).getTime());
    card.appendChild(deletionLine);

    const categoryLine = document.createElement("p");
    categoryLine.textContent = "类型：" + (CATEGORY_TEXT[item.category] || item.category);
    card.appendChild(categoryLine);

    const actions = document.createElement("p");
    actions.className = "draft-actions";

    const restoreButton = document.createElement("button");
    restoreButton.type = "button";
    restoreButton.textContent = "恢复资料";
    restoreButton.addEventListener("click", function () { restoreTrashItem(item.title, item.id, item.trashToken); });

    const purgeButton = document.createElement("button");
    purgeButton.type = "button";
    purgeButton.textContent = "永久删除";
    purgeButton.addEventListener("click", function () { purgeTrashItem(item.title, item.id, item.trashToken); });

    actions.appendChild(restoreButton);
    actions.appendChild(purgeButton);
    card.appendChild(actions);
    return card;
}

/** 从回收站恢复：不动编辑器/表单/核对区，只刷新草稿列表与回收站列表 */
async function restoreTrashItem(title, id, trashToken) {
    if (storageMode !== "server" || writesDisabled() || operationBusy) return;
    const restoreEpoch = accountEpoch;
    operationBusy = true;
    setStartupDisabled(true);
    disableTrashButtons(true);
    try {
        await serverApi.restoreTrash(id, trashToken);
        if (restoreEpoch !== accountEpoch) return;
        await renderDrafts();
        if (restoreEpoch !== accountEpoch) return;
        await renderTrash();
        if (restoreEpoch !== accountEpoch) return;
        setStorageStatus("已恢复“" + title + "”到资料列表（未发布）。编辑器与表单未改动。");
    } catch (error) {
        if (restoreEpoch !== accountEpoch) return;
        // 登录态由账号控制器接管
        if (error && (error.status === 401 || error.status === 403)) return;
        if (error && error.status === 409) {
            // token 已失效：提示用户手动刷新，保留现有列表，不自动重绘（自动刷新会清掉这条提示）
            setTrashStatus("这条资料已在其他窗口被操作过，本次未恢复。请点“刷新回收站”查看最新状态。", true);
            return;
        }
        setTrashStatus("恢复失败：" + (error && error.message ? error.message : "本机服务出错") + "。回收站列表未改动，请重试。", true);
    } finally {
        operationBusy = false;
        setStartupDisabled(false);
        disableTrashButtons(false);
    }
}

/** 永久删除：明确确认不可恢复；取消则零请求零改动；token 用卡片上捕获的 */
async function purgeTrashItem(title, id, trashToken) {
    if (storageMode !== "server" || writesDisabled() || operationBusy) return;
    const purgeEpoch = accountEpoch;
    operationBusy = true;
    setStartupDisabled(true);
    disableTrashButtons(true);
    try {
        const confirmed = window.confirm(
            "确定要永久删除“" + title + "”吗？回收站里这条资料的全部已保存版本和附件都会被彻底删除，无法恢复。" +
            "点“取消”则不做任何改动。"
        );
        if (!confirmed) return;
        await serverApi.purgeTrash(id, trashToken);
        if (purgeEpoch !== accountEpoch) return;
        await renderTrash();
        if (purgeEpoch !== accountEpoch) return;
        setTrashStatus("已永久删除“" + title + "”，全部版本和附件不可恢复。");
    } catch (error) {
        if (purgeEpoch !== accountEpoch) return;
        if (error && (error.status === 401 || error.status === 403)) return;
        if (error && error.status === 409) {
            setTrashStatus("这条资料已在其他窗口被操作过，本次未删除。请点“刷新回收站”查看最新状态。", true);
            return;
        }
        setTrashStatus("永久删除失败：" + (error && error.message ? error.message : "本机服务出错") + "。资料仍在回收站，请重试。", true);
    } finally {
        operationBusy = false;
        setStartupDisabled(false);
        disableTrashButtons(false);
    }
}

trashRefresh.addEventListener("click", function () {
    if (storageMode !== "server" || operationBusy) return;
    renderTrash();
});

// ============================================================
// 账户资料用量（只读，仅服务器模式且已登录）：
// serverApi.getUsage() 返回 {activeDrafts,trashedDrafts,versions,attachmentBytes}。
// attachmentBytes 是全部已保存版本累计保留的附件字节数，不是磁盘占用或配额。
// ============================================================

let usageReadSeq = 0;

function setUsageStatus(text, isError) {
    usageStatus.textContent = text;
    usageStatus.classList.toggle("status-error", Boolean(isError));
}

/** 需要重新登录时隐藏并清空用量区域；读序 +1 使晚到的响应作废 */
function hideUsage() {
    usageReadSeq += 1;
    usageSection.hidden = true;
    usageSummary.textContent = "";
    usageUpdated.textContent = "";
    usageStatus.textContent = "";
    usageStatus.classList.remove("status-error");
}

/** 显示附件保存量；0 直接显示 "0 B"，非 0 按 1024 进位选最大不超过 GiB 的单位 */
function formatUsageSize(bytes) {
    const units = ["B", "KiB", "MiB", "GiB"];
    let index = 0;
    let value = bytes;
    while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index += 1;
    }
    return (index === 0 ? value : value.toFixed(1)) + " " + units[index];
}

async function renderUsage() {
    if (storageMode !== "server" || !accounts || !accounts.canWrite()) return;
    const readEpoch = accountEpoch;
    const readSeq = ++usageReadSeq;
    // 先显示区域再发请求：首次 500 时重试入口也可见；失败保留上次统计
    usageSection.hidden = false;
    setUsageStatus("正在读取用量…");
    let usage;
    try {
        usage = await serverApi.getUsage();
    } catch (error) {
        if (readEpoch !== accountEpoch || readSeq !== usageReadSeq) return;
        if (error && (error.status === 401 || error.status === 403)) return;
        setUsageStatus("读取用量失败：" + (error && error.message ? error.message : "本机服务出错") + "。已显示的上次统计保留，请稍后点“刷新用量”重试。", true);
        return;
    }
    if (readEpoch !== accountEpoch || readSeq !== usageReadSeq) return;
    usageSummary.textContent = "资料列表 " + usage.activeDrafts +
        " 条；回收站资料 " + usage.trashedDrafts +
        " 条；已保存版本 " + usage.versions +
        " 个；附件保存量 " + formatUsageSize(usage.attachmentBytes) + "。";
    usageUpdated.textContent = "更新时间：" + formatTime(Date.now());
    setUsageStatus("用量已刷新。");
}

usageRefresh.addEventListener("click", function () {
    if (storageMode !== "server" || !accounts || !accounts.canWrite()) return;
    if (operationBusy) return;
    renderUsage();
});

// ============================================================
// 资料备份与恢复（仅服务器模式）：
// - 导出：把一条资料的 .studio-backup 备份（全部已保存版本+附件）下载到本机；
// - 恢复：把备份文件传给本机服务，生成一条全新的未发布草稿（新 id、全部历史），
//   原有资料不会改动；恢复期间不动编辑器/列表/历史，只刷新列表。
// 两个操作共用 operationBusy；备份文件不含账户凭据、不在前端解析备份格式。
// ============================================================

// 导出已渲染按钮；恢复时尊重 writesDisabled（存储失败/未登录则保持禁用）
function disableBackupButtons(disabled) {
    document.querySelectorAll(".export-backup").forEach(function (button) {
        button.disabled = disabled || writesDisabled();
    });
}

/** 生成安全的备份文件名；草稿 id 本身已安全，仍做一次白名单清洗兜底 */
function backupFileName(draftId) {
    const safeId = String(draftId).replace(/[^A-Za-z0-9._-]/g, "_");
    return "sidereal-" + safeId + ".studio-backup";
}

async function exportBackupFile(draft) {
    if (storageMode !== "server" || writesDisabled() || operationBusy) return;
    hideError();
    setStorageStatus("");
    // 锁住操作并记住当前账号纪元；期间换号/登出则丢弃迟到结果
    operationBusy = true;
    setStartupDisabled(true);
    storageModeSelect.disabled = true;
    disableBackupButtons(true);
    const exportEpoch = accountEpoch;
    try {
        const confirmed = window.confirm(
            "确定导出“" + draft.title + "”的备份文件吗？备份只包含这条资料已保存的全部版本和附件；" +
            "表单里未保存的修改不会包含在内，导出也不会改动这条资料。"
        );
        if (!confirmed) return;
        const blob = await serverApi.exportBackup(draft.id);
        if (exportEpoch !== accountEpoch) return;
        // 临时 Blob URL 触发下载，用完延迟释放；备份原样落盘，不在前端解析
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = backupFileName(draft.id);
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        setStorageStatus("已导出“" + draft.title + "”的备份文件（" + link.download + "），原资料未改动。");
    } catch (error) {
        if (exportEpoch === accountEpoch) {
            showError("导出备份失败：" + (error && error.message ? error.message : "本机服务出错") + "。资料与表单内容均未改动，请重试。");
        }
    } finally {
        operationBusy = false;
        storageModeSelect.disabled = false;
        setStartupDisabled(false);
        disableBackupButtons(false);
    }
}

async function restoreBackupFromFile() {
    if (storageMode !== "server" || writesDisabled() || operationBusy) return;
    if (!currentAccount) return;
    const file = backupInput.files && backupInput.files[0];
    if (!file) {
        showError("请先选择 .studio-backup 备份文件，再点“恢复备份”。");
        return;
    }
    if (file.size > serverApi.MAX_BACKUP_BYTES) {
        showError("备份文件超过 512MiB 上限，未上传。请确认文件大小后重新选择。");
        return;
    }
    hideError();
    setStorageStatus("");
    operationBusy = true;
    setStartupDisabled(true);
    storageModeSelect.disabled = true;
    disableBackupButtons(true);
    // 固定确认时的目标账户与纪元；期间换号/登出由 epoch 守卫丢弃迟到结果
    const targetAccount = currentAccount;
    const restoreEpoch = accountEpoch;
    try {
        const confirmed = window.confirm(
            "确定用备份文件“" + file.name + "”恢复到账户“" + targetAccount.username + "”吗？" +
            "会生成一条全新的未发布资料（新 id），包含备份里的全部已保存版本和附件；" +
            "它和原备份来源互不影响，也不会覆盖任何现有资料。"
        );
        if (!confirmed) return;
        const created = await serverApi.restoreBackup(file);
        if (restoreEpoch !== accountEpoch) return;
        await renderDrafts();
        if (restoreEpoch !== accountEpoch) return;
        // 服务端恢复成功，但列表刷新失败：不冒充成功、保留已选文件，避免误重复恢复
        if (storageFailed) {
            showError("备份已恢复，但资料列表刷新失败。请刷新后核对，避免重复恢复。");
            return;
        }
        setStorageStatus("已恢复备份“" + file.name + "”为账户“" + targetAccount.username +
            "”的新资料“" + (created && created.title ? created.title : file.name) + "”（未发布）。");
        // 只清备份选择框：防止误点重复恢复；编辑器/表单/历史/筛选一概不动
        backupInput.value = "";
    } catch (error) {
        if (restoreEpoch === accountEpoch) {
            showError("恢复备份失败：" + (error && error.message ? error.message : "本机服务出错") +
                "。已选择的备份文件保留。如果不确定服务端是否已恢复，请先在本资料列表里核对后再重试，避免重复恢复。");
        }
    } finally {
        operationBusy = false;
        storageModeSelect.disabled = false;
        setStartupDisabled(false);
        disableBackupButtons(false);
    }
}

restoreBackupButton.addEventListener("click", restoreBackupFromFile);

// ============================================================
// 复制到本机账户（仅浏览器模式出现）：把用户明确操作的一条
// 已保存资料的最新快照（标题/简介/类别/附件）复制为本机服务里
// 一条全新的未发布草稿。原资料及其版本历史原样保留；
// 必须先确认目标账户，且复制前需在“本机服务”模式下登录过。
// 绝不在加载或切换模式时自动迁移任何资料。
// ============================================================

// 复制期间统一禁用/恢复列表里已渲染的“复制到本机账户”按钮；
// 恢复时尊重 writesDisabled（如存储失败则保持禁用）
function disableCopyButtons(disabled) {
    const merged = disabled || writesDisabled();
    document.querySelectorAll(".copy-to-server").forEach(function (button) {
        button.disabled = merged;
    });
}

async function copyBrowserDraftToServer(id) {
    if (storageMode !== "browser" || writesDisabled() || operationBusy) return;
    // 防重从第一次 await 前开始：并发点击都会被这个共享标记拦下
    operationBusy = true;
    hideError();
    setStorageStatus("");
    setStartupDisabled(true);
    storageModeSelect.disabled = true;
    disableCopyButtons(true);
    try {
        // 重新读源资料：只复制最近一次保存的内容，绝不取当前未保存的表单值
        const readResult = await getDraftSafe(id);
        if (readResult === "read-error") {
            showError("读取资料失败，未复制任何内容。请重试。");
            return;
        }
        const source = readResult;
        if (!source) {
            showError("这条资料已不存在，无法复制。");
            await renderDrafts();
            return;
        }

        // 查询本机服务当前登录状态；未登录则提示手动去登录，不自动登录/建号
        const me = await serverApi.authMe();
        const user = me && me.user ? me.user : null;
        if (!user) {
            showError("未检测到已登录的本机服务账户。请先切换到“本机服务”登录或注册，再切回“当前浏览器”执行复制；不会自动登录或创建账户。");
            return;
        }

        const confirmed = window.confirm(
            "确定把“" + source.title + "”复制到本机服务账户“" + user.username + "”吗？" +
            "只复制最新一次保存的标题、简介、类别和附件；本浏览器里的原资料和版本历史保持不变；" +
            "新草稿从版本 1 开始且不会自动发布；再次复制会产生另一条独立草稿。"
        );
        if (!confirmed) return;
        hideError();
        // 固定确认时的账户；期间 Cookie 换号会被服务端拒绝
        serverApi.setUser(user);
        // 新 id 保证绝不覆盖源资料或其他既有服务端草稿；
        // versions 留空，服务端把新草稿作为版本 1 开始；版本历史不上传
        await serverApi.put({
            id: generateId(),
            title: source.title,
            description: source.description || "",
            category: source.category,
            file: source.file || null,
            versions: []
        });
        setStorageStatus("已把“" + source.title + "”复制到账户“" + user.username +
            "”。切换到“本机服务”即可看到新的一条未发布草稿（第 1 版）；本浏览器里的原资料保留。");
        // 不刷新、不切模式、不清编辑器、不自动发布
    } catch (error) {
        showError("复制未能确认保存：" + (error && error.message ? error.message : "本机服务出错") +
            "。原资料和当前表单均保留；重试前请先在“本机服务”核对目标账户的草稿列表，避免出现重复草稿。");
        return;
    } finally {
        // 浏览器模式不持有账户控制器：无论成功/取消/失败都解除钉住的账户
        serverApi.setUser(null);
        operationBusy = false;
        storageModeSelect.disabled = false;
        setStartupDisabled(false);
        disableCopyButtons(false);
    }
}

// 触发浏览器下载原文件：本地附件用 Blob URL（用完立即释放），
// 服务器附件直接用服务提供的下载地址，均不解析、不执行附件内容
function downloadAttachment(fileRecord) {
    if (fileRecord.blob) {
        // 浏览器附件：以 Blob URL 下载，URL 用完立即释放
        const url = URL.createObjectURL(fileRecord.blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = fileRecord.name;
        document.body.appendChild(link);
        link.click();
        link.remove();
        // 释放内存里的 Blob URL，避免泄漏
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        return;
    }
    // 服务器附件：直接以服务的下载地址触发下载，不解析附件
    const link = document.createElement("a");
    link.href = fileRecord.url;
    link.download = fileRecord.name;
    document.body.appendChild(link);
    link.click();
    link.remove();
}

// ============================================================
// 编辑（阶段三）：载入当前资料，附件与新选文件的处理见状态行
// ============================================================
async function startEdit(id) {
    if (writesDisabled() || operationBusy) return;
    hideError();
    const readResult = await getDraftSafe(id);
    if (readResult === "read-error") {
        showError("读取资料失败，未载入任何资料。请重试。");
        return;
    }
    const draft = readResult;
    if (!draft) {
        showError("这条资料已不存在，列表即将刷新。");
        await renderDrafts();
        return;
    }

    editingId = draft.id;
    // 记住载入时的服务器版本号；保存前用它核对，防止覆盖其他窗口的改动
    editingRevision = (typeof draft.revision === "number") ? draft.revision : null;
    // 浏览器附件含 Blob，本机服务附件含下载地址；直接沿用已保存的对象。
    currentAttachment = draft.file;
    attachmentRemoved = false;

    titleInput.value = draft.title;
    descriptionInput.value = draft.description || "";
    categorySelect.value = draft.category;

    // 浏览器文件 input 无法（也不应）回填旧文件：
    // 清空它，“当前附件”由状态行显示，不新选就不用它。
    // 同时隐藏上一条资料的核对结果，避免误当作本条的结果。
    fileInput.value = "";
    reviewSection.hidden = true;
    saveDraftButton.textContent = "保存修改";
    updateAttachmentStatus();
    updateEditingStatus();

    setStorageStatus("已载入资料：“" + draft.title + "”，编辑后点保存更新。");
    titleInput.focus();
    titleInput.scrollIntoView({ block: "center" });
}

// ============================================================
// 删除（阶段三）：window.confirm 确认；写库成功才更新列表。
// 浏览器模式直接删除本地记录及其版本；
// 服务器模式改为移入回收站：服务端保留全部版本和附件、
// 撤回已发布的公共版本，恢复后仍是未发布状态。
// 删的是保存在浏览器里的本地副本，不影响电脑上的原文件。
// ============================================================
async function removeDraft(id) {
    if (writesDisabled() || operationBusy) return;
    // 固定开始时的账号纪元；期间登出/换号由 epoch 守卫丢弃结果，不动界面
    const removeEpoch = accountEpoch;
    operationBusy = true;
    setStartupDisabled(true);
    try {
        const readResult = await getDraftSafe(id);
        if (removeEpoch !== accountEpoch) return;
        if (readResult === "read-error") {
            showError("读取资料失败，无法删除。请重试。");
            return;
        }
        if (!readResult) {
            showError("这条资料已不存在。");
            await renderDrafts();
            if (removeEpoch !== accountEpoch) return;
            // 服务器模式同步刷新回收站，避免回收站与实际状态脱节
            if (storageMode === "server") await renderTrash();
            return;
        }
        const target = readResult;
        // server 模式：删除=移入回收站；已发布的会同时撤回公共版本，恢复后仍为未发布
        const confirmed = window.confirm(storageMode === "server"
            ? "确定把“" + target.title + "”移入回收站吗？回收站会保留这条资料的全部已保存版本和附件，不会立刻删除" +
              (target.publication ? "；该资料已发布到公共仓库，移入时将同时撤回公共版本，公共仓库里不再可见" : "") +
              "。日后从回收站恢复时它仍是未发布状态。电脑上的原文件不受影响。"
            : "确定要删除“" + target.title + "”吗？将删除本地保存的这条资料及其全部版本。电脑上的原文件不受影响。");
        if (!confirmed) {
            // 取消：什么都不改
            return;
        }
        try {
            const db = await dbPromise;
            // 换号/登出后再发删除：纪元已变则不做任何写操作
            if (removeEpoch !== accountEpoch) return;
            // 第三个参数是确认时看到的版本号，服务器用它防并发误删（本地忽略）
            await deleteDraftById(db, id, target.revision);
        } catch (error) {
            // 期间换号/登出：由账号控制器接管界面，不覆盖提示
            if (removeEpoch !== accountEpoch) return;
            showError("删除失败：" + (error && error.message ? error.message : "数据库操作出错") + "。资料仍在。");
            return;
        }
        if (removeEpoch !== accountEpoch) return;

        // 正在编辑的正好是它：回到新建状态，避免把已删资料再存一份
        if (editingId === id) {
            editingId = null;
            currentAttachment = null;
            attachmentRemoved = false;
            editingRevision = null;
            saveDraftButton.textContent = "保存草稿";
            updateAttachmentStatus();
            updateEditingStatus();
        }
        if (historyDraftId === id) {
            closeHistory();
        }
        setStorageStatus(storageMode === "server"
            ? "已移入回收站“" + target.title + "”。可稍后在资料回收站恢复或永久删除。"
            : "已删除本地保存的“" + target.title + "”。");
        await renderDrafts();
        if (removeEpoch !== accountEpoch) return;
        // 服务器模式同步刷新回收站列表
        if (storageMode === "server") await renderTrash();
    } finally {
        operationBusy = false;
        setStartupDisabled(false);
    }
}

/** 读单条：读库失败时返回 "read-error" 哨兵，真正没有记录才返回 null */
async function getDraftSafe(id) {
    try {
        const db = await dbPromise;
        return await getDraft(db, id);
    } catch (error) {
        return "read-error";
    }
}

// ============================================================
// 版本历史（阶段四）：某条资料每次保存的快照，
// 可恢复旧版本为 newest 版本；恢复会同步当前编辑表单。
// ============================================================
let historyDraftId = null;

async function openHistory(id) {
    if (storageFailed) return;
    const readResult = await getDraftSafe(id);
    if (readResult === "read-error") {
        showError("读取资料失败，无法查看历史。请重试。");
        return;
    }
    const draft = readResult;
    if (!draft) {
        showError("这条资料已不存在，无法查看历史。");
        await renderDrafts();
        return;
    }
    historyDraftId = id;
    // 记住打开历史时的版本号；恢复前核对，防止覆盖没看到的新版本
    historyRevision = (typeof draft.revision === "number") ? draft.revision : null;
    historySection.hidden = false;
    historyLabel.textContent = " “" + draft.title + "” 共 " + draft.versions.length + " 个版本（老版本在前）。";
    historyList.textContent = "";

    if (draft.versions.length === 0) {
        const empty = document.createElement("p");
        empty.className = "empty-hint";
        empty.textContent = "这条资料还没有版本记录。";
        historyList.appendChild(empty);
        return;
    }

    // versions 存的是从 1 开始的快照，按顺序展示
    draft.versions.forEach(function (version) {
        historyList.appendChild(buildHistoryItem(draft, version));
    });
}

function buildHistoryItem(draft, version) {
    const item = document.createElement("article");
    item.className = "history-item";

    const head = document.createElement("p");
    head.className = "history-head";
    head.textContent = "版本 " + version.version + "（保存于 " + formatTime(version.savedAt) + "）";
    item.appendChild(head);

    const titleLine = document.createElement("p");
    titleLine.textContent = "标题：" + version.title;
    item.appendChild(titleLine);

    const descLine = document.createElement("p");
    descLine.className = "draft-description";
    descLine.textContent = "简介：" + (version.description || EMPTY_DESCRIPTION_TEXT);
    item.appendChild(descLine);

    const categoryLine = document.createElement("p");
    categoryLine.textContent = "类型：" + (CATEGORY_TEXT[version.category] || version.category);
    item.appendChild(categoryLine);

    const fileLine = document.createElement("p");
    fileLine.textContent = "附件：" + (version.file ? version.file.name : EMPTY_FILE_TEXT);
    item.appendChild(fileLine);

    const restoreButton = document.createElement("button");
    restoreButton.type = "button";
    restoreButton.textContent = "恢复此版本";
    restoreButton.addEventListener("click", function () {
        restoreVersion(draft.id, version.version);
    });
    item.appendChild(restoreButton);
    return item;
}

/**
 * 恢复旧版本：
 * - 把旧快照复制为新的最新版本（版本号接着递增），原来所有版本原样保留；
 * - 记录本身的 title/description/category/file 也被更新为该旧版内容；
 * - 同步当前编辑表单（防止下一次保存把刚恢复的内容覆盖掉）。
 * 任何一步失败：提示且不改动任何数据。
 */
async function restoreVersion(id, versionNumber) {
    if (writesDisabled() || operationBusy) return;
    operationBusy = true;
    saveDraftButton.disabled = true;
    newDraftButton.disabled = true;
    try {
        const readResult = await getDraftSafe(id);
        if (readResult === "read-error") {
            showError("读取资料失败，无法恢复。请重试。");
            return;
        }
        const draft = readResult;
        if (!draft) {
            showError("这条资料已不存在，无法恢复。");
            await renderDrafts();
            return;
        }
        // 打开历史后这条资料又发过新版本：让用户重新看历史，不盲目覆盖
        if (typeof draft.revision === "number" && draft.revision !== historyRevision) {
            showError("这条资料在打开历史后有了新版本，请重新打开版本历史后再恢复。表单内容未丢弃。");
            return;
        }
        const version = draft.versions.find(function (item) {
            return item.version === versionNumber;
        });
        if (!version) {
            showError("找不到版本 " + versionNumber + "，未恢复。");
            return;
        }

        // 先算好要写入的数据；写库成功之前不动任何编辑/界面状态。
        // 附件直接复用版本里的 {name, blob:真实Blob} 对象，不重复包装。
        const restoredFile = version.file;
        const restoredVersions = draft.versions.slice();
        restoredVersions.push({
            version: restoredVersions.length + 1,
            savedAt: Date.now(),
            title: version.title,
            description: version.description || "",
            category: version.category,
            file: restoredFile
        });
        const updated = {
            id: draft.id,
            title: version.title,
            description: version.description || "",
            category: version.category,
            file: restoredFile,
            createdAt: draft.createdAt,
            updatedAt: Date.now(),
            versions: restoredVersions
        };

        const db = await dbPromise;
        const saved = await putDraft(db, updated);

        // ---- 事务成功后，才把旧版内容同步到编辑表单与当前附件 ----
        editingId = draft.id;
        if (isServerDb(db)) {
            // 服务器恢复成功：用返回 DTO 校准版本号与当前附件，后续保存才能正确核对
            editingRevision = saved ? saved.revision : editingRevision;
            currentAttachment = saved && saved.file ? saved.file : null;
        } else {
            currentAttachment = restoredFile; // 未新选文件时保存继续沿用这一规范对象
        }
        attachmentRemoved = false;
        titleInput.value = version.title;
        descriptionInput.value = version.description || "";
        categorySelect.value = version.category;
        fileInput.value = "";
        saveDraftButton.textContent = "保存修改";
        updateAttachmentStatus();
        updateEditingStatus();
        // 恢复成功后旧核对结果作废：隐藏核对区域
        reviewSection.hidden = true;

        setStorageStatus("已把版本 " + versionNumber + " 恢复为第 " + restoredVersions.length + " 个版本（原版本保留）。");
        await renderDrafts();
        openHistory(id);
    } catch (error) {
        // 恢复失败：提示且不改动任何数据（表单/附件/列表/历史保持原状）
        showError("恢复失败：" + (error && error.message ? error.message : "数据库操作出错") + "。资料未改动。");
        return;
    } finally {
        operationBusy = false;
        saveDraftButton.disabled = writesDisabled();
        newDraftButton.disabled = writesDisabled();
    }
}

function closeHistory() {
    historySection.hidden = true;
    historyDraftId = null;
    historyRevision = null;
    historyList.textContent = "";
    historyLabel.textContent = "";
}

// ============================================================
// 启动与保存位置切换（阶段五）：
// - browser（默认）：沿用原来的 IndexedDB 逻辑；
// - server：先对本机服务做健康检查，成功后 resolve {kind:"server"} 标记，
//   全程不依赖 IndexedDB。
// 初始化成功前保存相关按钮先禁用，失败给出可见提示并保持禁用。
// ============================================================
setStartupDisabled(true);
storageMode = readStoredMode();
storageModeSelect.value = storageMode;
// 公共仓库预览只在服务器模式显示；浏览器模式不显示，也绝不迁移/上传任何资料
publicSection.hidden = storageMode !== "server";
// 备份区只在服务器模式显示；恢复按钮进一步由登录状态守卫（配合 setStartupDisabled）
backupSection.hidden = storageMode !== "server";
backupInput.disabled = storageMode !== "server";
setStorageNote();
connectStorage();

// 读记住的保存位置；只读这个字符串，读不到就用默认“当前浏览器”
function readStoredMode() {
    try {
        return localStorage.getItem(STORAGE_MODE_KEY) === "server" ? "server" : "browser";
    } catch (error) {
        return "browser";
    }
}

function connectStorage() {
    if (storageMode === "server") {
        // 服务器模式：健康检查后交给账号控制器初始化登录界面；
        // 登录成功后由 hooks.onAuthenticated 载入本人资料列表，这里不直接渲染
        dbPromise = serverApi.health().then(function () {
            if (!accounts) {
                accounts = createAccountUi({
                    isBusy: function () { return operationBusy; },
                    setBusy: function (value) {
                        operationBusy = value;
                        setStartupDisabled(value);
                        storageModeSelect.disabled = value;
                    },
                    hasEditorContent: function () {
                        return Boolean(editingId || titleInput.value.trim() || descriptionInput.value.trim() || fileInput.files[0]);
                    },
                    clearEditor: function () { clearEditor(); },
                    onAuthenticated: async function (user) {
                        accountEpoch += 1;
                        const loginEpoch = accountEpoch;
                        currentAccount = user;
                        storageFailed = false;
                        dbPromise = Promise.resolve({ kind: "server" });
                        await renderDrafts();
                        if (loginEpoch !== accountEpoch) return;
                        // 登录成功后先列资料，再列回收站；随后读用量；失败不影响上面
                        await renderTrash();
                        if (loginEpoch !== accountEpoch) return;
                        await renderUsage();
                        if (loginEpoch !== accountEpoch) return;
                        if (!storageFailed) {
                            setStorageStatus("已登录：" + user.username);
                        }
                        setStartupDisabled(operationBusy);
                    },
                    onRequired: function () {
                        accountEpoch += 1;
                        currentAccount = null;
                        serverApi.setUser(null);
                        librarySection.hidden = true;
                        draftList.textContent = "";
                        closeHistory();
                        // 回收站跟着隐藏清空；读序 +1 使晚到的列表响应作废
                        hideTrash();
                        // 用量跟着隐藏清空；读序 +1 使晚到的统计响应作废
                        hideUsage();
                        setStartupDisabled(true);
                        setStorageStatus("请先登录；未保存的表单仍保留。");
                    }
                });
            }
            return accounts.initialize();
        }).then(function () {
            return { kind: "server" };
        }).catch(function (error) {
            if (!storageFailed) {
                disableSaveUi("本机服务当前不可用：" + (error && error.message ? error.message : "无法连接") + "。保存、新建、编辑、删除功能已停用，请确认服务已启动后刷新重试。");
            }
        });
        return;
    }
    dbPromise = openDatabase();
    dbPromise.then(function () {
        return renderDrafts();
    }).then(function () {
        if (!storageFailed) {
            setStartupDisabled(false);
        }
    }).catch(function (error) {
        if (!storageFailed) {
            disableSaveUi("本地数据库当前不可用：" + (error && error.message ? error.message : "无法打开数据库") + "。保存、新建、编辑、删除功能已停用，请检查浏览器存储设置后刷新重试。");
        }
    });
}

// 按当前保存位置更新说明；两种模式都提醒核对不保存、未保存表单刷新不保留
function setStorageNote() {
    const note = document.getElementById("storageNote");
    if (!note) return;
    note.textContent = storageMode === "server"
        ? "先填内容点“核对资料”检查：核对不保存，只看当前表单；“刷新不保留”指未保存的表单内容和核对结果。已保存的资料和附件归当前登录账户所有，这台电脑上的其他浏览器也需登录同一账号才能查看；公共仓库只展示手动发布的版本，单个附件最大 50MB，目前未开放互联网。"
        : "先填内容点“核对资料”检查：核对不保存，只看当前表单；“刷新不保留”指未保存的表单内容和核对结果。点“保存草稿”后资料和附件保存在当前浏览器，不上传、不跨设备同步，清理站点数据会删除保存内容。“复制到本机账户”仅复制最新已保存内容及附件，生成未发布的第1版草稿；原件和历史保留。请先切换至“本机服务”登录，再切回执行。";
}

// 切换保存位置：busy 时拒绝；表单非空先确认会清空；
// 先验证新位置真的可读（server=health+列表读取；browser=临时连接读一次后 close），
// 再记住选择并刷新完成切换；验证/记忆失败保持现状，不 reload、不清空表单
storageModeSelect.addEventListener("change", async function () {
    if (operationBusy) {
        storageModeSelect.value = storageMode;
        return;
    }
    const nextMode = storageModeSelect.value;
    if (nextMode === storageMode) return;

    const hasFormContent = Boolean(
        titleInput.value.trim() || descriptionInput.value.trim() || fileInput.files[0]
    );
    if (hasFormContent) {
        const confirmed = window.confirm(
            "切换会清空当前表单；已保存的资料仍保留在原位置，不会被移动或删除。要继续切换吗？"
        );
        if (!confirmed) {
            storageModeSelect.value = storageMode;
            return;
        }
    }

    // 验证期间锁住操作，防止并行保存或重复切换；finally 按原状态恢复
    operationBusy = true;
    saveDraftButton.disabled = true;
    newDraftButton.disabled = true;
    storageModeSelect.disabled = true;
    try {
        try {
            if (nextMode === "server") {
                // 健康检查通过后先查登录状态：已登录才确认资料真的可读；
                // 未登录就不读列表，允许切换后先显示登录界面
                await serverApi.health();
                const me = await serverApi.authMe();
                if (me && me.user) {
                    serverApi.setUser(me.user);
                    await serverApi.list();
                }
            } else {
                // 浏览器位置：临时开库读一次验证，读完立即关闭连接
                const tempDb = await openDatabase();
                try {
                    await getAllDrafts(tempDb);
                } finally {
                    tempDb.close();
                }
            }
        } catch (error) {
            storageModeSelect.value = storageMode;
            showError("切换保存位置失败：" + (error && error.message ? error.message : "新位置不可用") + "。未切换，表单内容未清空。");
            return;
        }

        try {
            localStorage.setItem(STORAGE_MODE_KEY, nextMode);
        } catch (error) {
            storageModeSelect.value = storageMode;
            showError("记住保存位置失败（浏览器存储不可用），未切换，表单内容未清空。");
            return;
        }
        // 刷新完成切换：未保存的表单按确认提示清空，已保存资料不受影响
        location.reload();
    } finally {
        operationBusy = false;
        saveDraftButton.disabled = writesDisabled();
        newDraftButton.disabled = writesDisabled();
        storageModeSelect.disabled = false;
    }
});

// 提醒：页面刷新后已保存资料（在所选位置）还在，可以被重新显示；
// “刷新不保留”只适用于没保存过的表单内容和核对结果。
