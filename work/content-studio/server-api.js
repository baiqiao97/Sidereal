// ============================================================
// server-api.js（阶段五）：本机保存服务的前端适配层。
// 只用原生 fetch/FormData；HTTP 细节集中在这里，app.js 不感知。
// ============================================================
const serverApi = (function () {
    // 与服务端一致：单个附件上限 50MiB
    const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
    // 与服务端一致：备份文件上限 512MiB
    const MAX_BACKUP_BYTES = 512 * 1024 * 1024;

    // 当前用户 id，仅保存在内存中；由 app 在登录/登出后调用 setUser 维护
    let currentUserId = null;
    // 身份纪元：每次 setUser（即使同一用户）都递增；防止被吊销旧会话的迟到
    // 401/403 把刚刚重新登录的“同一账号”也误登出
    let identityEpoch = 0;

    function draftUrl(id) {
        return "/api/drafts/" + encodeURIComponent(id);
    }

    // 私有请求：/api/drafts 需要 X-Studio-User，401/403 派发登录提醒；
    // 修改密码需要当前会话身份，也按私有请求处理（登录/注册保持公共）；
    // 公共资料导入（保存到我的草稿）会创建私有草稿，也按私有请求处理；
    // 备份恢复会创建新的私有草稿（精确匹配该地址），同样带身份并遵守迟到账号守卫
    function isPrivateRequest(url) {
        return url.indexOf("/api/drafts") === 0 ||
            url === "/api/auth/password" ||
            /^\/api\/publications\/[^/]+\/import$/.test(url) ||
            url === "/api/backups/restore";
    }

    // 统一 fetch：为私有请求注入 X-Studio-User 头（内存中的当前用户 id）；
    // 仅当私有请求返回 401/403 时派发私有登录提醒事件；网络失败抛可读 Error
    async function checkedFetch(url, options) {
        const requestUserId = currentUserId;
        const requestEpoch = identityEpoch;
        const merged = options ? Object.assign({}, options) : {};
        if (currentUserId && isPrivateRequest(url)) {
            const headers = new Headers(merged.headers || {});
            headers.set("X-Studio-User", currentUserId);
            merged.headers = headers;
        }
        let response;
        try {
            response = await fetch(url, merged);
        } catch (error) {
            throw new Error("无法连接本机保存服务，请确认服务已启动后重试");
        }
        // 仅当用户id与纪元均未变化（未被新的 setUser 更替）时才派发登录提醒；
        // 防止迟到的旧会话 401/403 登出刚刚重新登录的同一账号
        if ((response.status === 401 || response.status === 403) && isPrivateRequest(url) &&
            currentUserId === requestUserId && identityEpoch === requestEpoch) {
            window.dispatchEvent(new Event("studio-auth-required"));
        }
        return response;
    }

    // 统一请求：网络失败/HTTP 错误抛可读 Error（带 status）；204 不解析 JSON；其余解析 JSON
    async function request(url, options) {
        const response = await checkedFetch(url, options);
        if (response.status === 204) return null;
        let body = null;
        try {
            body = await response.json();
        } catch (error) {
            body = null;
        }
        if (!response.ok) {
            if (response.status === 409 && url.indexOf("/api/drafts") === 0) {
                const conflict = new Error("这条资料刚被其他窗口修改，你手里的版本信息已过期。请刷新资料列表或重新打开这条资料看清最新版本后再试，以免覆盖别人的改动");
                conflict.status = 409;
                throw conflict;
            }
            const failure = new Error((body && body.error) || ("本机保存服务出错（HTTP " + response.status + "）"));
            failure.status = response.status;
            throw failure;
        }
        if (body === null) {
            throw new Error("本机保存服务返回了无法解析的数据");
        }
        return body;
    }

    // 服务器时间可能是字符串，统一转成毫秒数，列表排序/时间展示逻辑不变
    function toMillis(value) {
        if (typeof value === "number") return value;
        if (typeof value === "string") {
            const parsed = Date.parse(value);
            if (!isNaN(parsed)) return parsed;
        }
        return value;
    }

    function normalizeDraft(draft) {
        if (!draft) return draft;
        draft.createdAt = toMillis(draft.createdAt);
        draft.updatedAt = toMillis(draft.updatedAt);
        (draft.versions || []).forEach(function (version) {
            version.savedAt = toMillis(version.savedAt);
        });
        return draft;
    }

    return {
        // 备份文件大小上限（512MiB）；app 层在禁止性校验/提示里复用该值
        MAX_BACKUP_BYTES: MAX_BACKUP_BYTES,

        health: function () {
            return request("/api/health", { method: "GET" });
        },

        list: function () {
            return request("/api/drafts", { method: "GET" }).then(function (items) {
                return (items || []).map(normalizeDraft);
            });
        },

        // 资料确实不存在（404）返回 null；连接失败等其他读错误抛出
        get: async function (id) {
            const response = await checkedFetch(draftUrl(id));
            if (response.status === 404) return null;
            if (!response.ok) {
                const failure = new Error("读取资料失败（HTTP " + response.status + "）");
                failure.status = response.status;
                throw failure;
            }
            let body = null;
            try {
                body = await response.json();
            } catch (error) {
                body = null;
            }
            if (body === null) {
                throw new Error("本机保存服务返回了无法解析的资料数据");
            }
            return normalizeDraft(body);
        },

        // 只发送本次内容（metadata=JSON、file 可选 File），不上传完整历史
        put: async function (record) {
            const versions = Array.isArray(record.versions) ? record.versions : [];
            // expectedVersion：0 表示新建；更新时等于服务器当前 revision，冲突 409
            const metadata = {
                title: record.title,
                description: record.description || "",
                category: record.category,
                expectedVersion: versions.length > 0 ? versions.length - 1 : 0
            };

            if (record.file && record.file.blob instanceof Blob) {
                // 新附件优先：真实 Blob 直接上传，附带原始文件名
                if (record.file.blob.size > MAX_ATTACHMENT_BYTES) {
                    throw new Error("附件超过 50MB 上限，请换更小的文件");
                }
                const form = new FormData();
                form.append("metadata", JSON.stringify(metadata));
                form.append("file", record.file.blob, record.file.name);
                return normalizeDraft(await request(draftUrl(record.id), { method: "PUT", body: form }));
            }

            if (record.file && Number.isInteger(record.file.version)) {
                // 没新文件但沿用旧附件：让服务复用对应版本的附件，不上传内容
                metadata.attachmentVersion = record.file.version;
            }
            const form = new FormData();
            form.append("metadata", JSON.stringify(metadata));
            return normalizeDraft(await request(draftUrl(record.id), { method: "PUT", body: form }));
        },

        // expectedVersion 传确认删除时看到的版本号，服务端防并发误删；成功 204 不解析
        remove: function (id, expectedVersion) {
            return request(draftUrl(id), {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ expectedVersion: expectedVersion })
            });
        },

        // ---- 公共仓库（已发布快照）适配；复用上面的 request/normalizeDraft，不影响旧接口 ----

        // 已发布快照列表；publishedAt 保留服务器原样（ISO 字符串），由 public.js 自己 new Date 展示
        listPublications: function () {
            return request("/api/publications", { method: "GET" });
        },

        // 单条已发布快照详情：公开只读复用上面的 request，不走私有请求（无登录头/登录事件）；
        // 编号 encodeURIComponent；错误统一由 request 抛出并保留 HTTP 状态（404 已撤回/不存在、400 编号无效）
        getPublication: function (id) {
            return request("/api/publications/" + encodeURIComponent(id), { method: "GET" });
        },

        // 发布：expectedVersion 传卡片上当前看到的草稿 revision；版本过期 409，成功返回完整新草稿 DTO
        publish: function (id, expectedVersion) {
            return request(draftUrl(id) + "/publication", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ expectedVersion: expectedVersion })
            }).then(normalizeDraft);
        },

        // 撤回发布：expectedPublishedVersion 传卡片上看到的 publication.version；
        // 公共版本过期 409 / 未发布 404，成功返回完整草稿 DTO
        unpublish: function (id, expectedPublishedVersion) {
            return request(draftUrl(id) + "/publication", {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ expectedPublishedVersion: expectedPublishedVersion })
            }).then(normalizeDraft);
        },

        // 把一条已发布公共快照复制为当前登录用户的草稿：
        // expectedPublishedVersion 传卡片上看到的 publication.version；
        // 401 未登录 / 403 账号不符 / 404 已撤回 / 409 公开版本已变化（409 保留服务器 body.error，不套草稿固定冲突文案），
        // 成功 201 返回完整新草稿 DTO；导入后副本与公共源互相独立
        importPublication: function (id, expectedPublishedVersion) {
            return request("/api/publications/" + encodeURIComponent(id) + "/import", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ expectedPublishedVersion: expectedPublishedVersion })
            }).then(normalizeDraft);
        },

        // ---- 资料备份与恢复：二进制请求，不走 FormData，也不在前端解析备份格式 ----

        // 导出一条资料的 .studio-backup 备份文件；成功返回 Blob 交给上层下载；
        // 非 2xx 解析 JSON 错误文案并保留 HTTP status，方便上层给出可读提示
        exportBackup: async function (id) {
            const response = await checkedFetch(draftUrl(id) + "/backup", { method: "GET" });
            if (response.ok) return response.blob();
            let body = null;
            try {
                body = await response.json();
            } catch (error) {
                body = null;
            }
            const failure = new Error((body && body.error) || ("导出备份失败（HTTP " + response.status + "）"));
            failure.status = response.status;
            throw failure;
        },

        // 把 .studio-backup 文件交给服务端恢复：创建一条全新的未发布草稿（新 id、全部历史），
        // 原有资料不会改动；上传前在客户端先拦截超 512MiB 的备份；成功 201 返回新草稿 DTO
        restoreBackup: async function (file) {
            if (file && file.size > MAX_BACKUP_BYTES) {
                throw new Error("备份文件超过 512MiB 上限，未上传，请确认文件大小后重试");
            }
            return normalizeDraft(await request("/api/backups/restore", {
                method: "POST",
                headers: { "Content-Type": "application/octet-stream" },
                body: file
            }));
        },

        // ---- 认证适配：适配层不做表单验证、不自行 setUser、不保存密码/token ----

        // app 在登录/注册/登出成功后调用；只在内存中保存用户 id；
        // 即使同一用户也递增纪元，使旧会话的迟到 401/403 失效
        setUser: function (user) {
            currentUserId = user && user.id != null ? String(user.id) : null;
            identityEpoch++;
        },

        // 成功返回 {user:{id,username} 或 null, needsSetup, legacyDraftCount}
        authMe: function () {
            return request("/api/auth/me", { method: "GET" });
        },

        // 成功 201 返回 {user:{id,username}}；cookie 由服务端 Set-Cookie
        authSetup: function (username, password, claimLegacy) {
            return request("/api/auth/setup", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ username: username, password: password, claimLegacy: !!claimLegacy })
            });
        },

        // 成功 201 返回 {user:{id,username}}
        authRegister: function (username, password) {
            return request("/api/auth/register", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ username: username, password: password })
            });
        },

        // 成功 200 返回 {user:{id,username}}；密码错误 401 由 request 抛错，不触发 auth 事件
        authLogin: function (username, password) {
            return request("/api/auth/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ username: username, password: password })
            });
        },

        authLogout: function () {
            return request("/api/auth/logout", { method: "POST" });
        },

        // 修改密码：成功 200 {changed:true}，服务端吊销该用户全部会话并清 cookie；
        // 当前密码错误 400 抛错（保持登录）；会话失效 401/403 走统一登录提醒
        authChangePassword: function (currentPassword, newPassword) {
            return request("/api/auth/password", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ currentPassword: currentPassword, newPassword: newPassword })
            });
        }
    };
})();
