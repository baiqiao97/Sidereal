const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { MAX_BACKUP_BYTES } = require('./backup.cjs');
const { createStore } = require('./store.cjs');

// 启动：node server.cjs <root> [port] [数据目录]，数据默认存 root/data
const root = path.resolve(process.argv[2]);
const port = Number(process.argv[3] || 4173);
const dataDir = path.resolve(process.argv[4] || path.join(root, 'data'));
const maxBodyBytes = 52 * 1024 * 1024;
const maxFileBytes = 50 * 1024 * 1024;
// 密码端点 JSON 正文上限 8KiB；草稿正文仍为 52MiB
const authBodyMaxBytes = 8 * 1024;
const localHost = `127.0.0.1:${port}`;
const localOrigin = `http://127.0.0.1:${port}`;

// 使用固定的本机来源，保持浏览器保存位置和后端接口的地址一致。
// 静态白名单维持原状；server-api.js 供前端接入，文件未创建时按普通缺失返回 404。
const files = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/index.html', ['index.html', 'text/html; charset=utf-8']],
    ['/style.css', ['style.css', 'text/css; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/server-api.js', ['server-api.js', 'text/javascript; charset=utf-8']],
    ['/account-ui.js', ['account-ui.js', 'text/javascript; charset=utf-8']],
    ['/public', ['public.html', 'text/html; charset=utf-8']],
    ['/public.html', ['public.html', 'text/html; charset=utf-8']],
    ['/public.js', ['public.js', 'text/javascript; charset=utf-8']]
]);

let store;
try {
    fs.mkdirSync(dataDir, { recursive: true });
    store = createStore(path.join(dataDir, 'drafts.db'));
} catch (error) {
    console.error('Unable to open database: ' + error.message);
    process.exit(1);
}

function fail(status, message, allow) {
    const error = new Error(message);
    error.status = status;
    if (allow) error.allow = allow;
    return error;
}

function sendJson(response, status, data, extra) {
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
    if (extra) Object.assign(headers, extra);
    response.writeHead(status, headers);
    response.end(JSON.stringify(data));
}

function originAllowed(request) {
    // 带 Origin 时只接受本机来源；无 Origin 时命令行可用，但浏览器 cross-site 请求拒绝
    const origin = request.headers.origin;
    if (origin) return origin === localOrigin;
    return request.headers['sec-fetch-site'] !== 'cross-site';
}

// 读取完整请求体，累计超过上限立即拒绝；limit 可选（密码端点 8KiB，默认 52MiB）
function readBody(request, limit) {
    const maxBytes = limit == null ? maxBodyBytes : limit;
    const overrunMessage = maxBytes === maxBodyBytes ? '请求正文超过 52MiB' : '请求正文超过上限';
    if (request.method === 'GET' || request.method === 'HEAD') return Promise.resolve(Buffer.alloc(0));
    const declared = Number(request.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) return Promise.reject(fail(413, overrunMessage));
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        request.on('data', chunk => {
            total += chunk.length;
            if (total > maxBytes) {
                request.pause();
                reject(fail(413, overrunMessage));
                return;
            }
            chunks.push(chunk);
        });
        request.on('end', () => resolve(Buffer.concat(chunks)));
        request.on('error', () => reject(fail(400, '连接中断')));
    });
}

// 用内置 Request(formData) 解析 multipart，全过程无网络请求
async function parseMultipart(body, contentType) {
    if (!/^multipart\/form-data\b/i.test(String(contentType))) throw fail(400, '必须以 multipart/form-data 提交');
    const message = new Request(localOrigin + '/', { method: 'PUT', headers: { 'content-type': contentType }, body });
    let form;
    try {
        form = await message.formData();
    } catch {
        throw fail(400, 'multipart 数据格式不正确');
    }
    const raw = form.get('metadata');
    if (typeof raw !== 'string') throw fail(400, '缺少 metadata 字段');
    let metadata;
    try {
        metadata = JSON.parse(raw);
    } catch {
        throw fail(400, 'metadata 不是有效 JSON');
    }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw fail(400, 'metadata 必须是对象');
    let uploadedFile = null;
    const part = form.get('file');
    if (part != null) {
        if (typeof part === 'string' || typeof part.arrayBuffer !== 'function') throw fail(400, 'file 字段必须是文件');
        const bytes = Buffer.from(await part.arrayBuffer());
        if (bytes.length > maxFileBytes) throw fail(413, '单个附件超过 50MiB');
        uploadedFile = { name: typeof part.name === 'string' ? part.name : '', type: typeof part.type === 'string' ? part.type : '', bytes };
    }
    return { metadata, uploadedFile };
}

// 读取并解析 JSON 正文：无效 JSON 或非对象正文统一 400；limit 传入 readBody
async function readJson(request, limit) {
    const body = await readBody(request, limit);
    let payload;
    try {
        payload = JSON.parse(body.toString('utf8'));
    } catch {
        throw fail(400, '请求正文不是有效 JSON');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw fail(400, '请求正文必须是对象');
    return payload;
}

function sendAttachment(response, file) {
    // 附件名只作为数据处理；RFC 5987 编码保证中文文件名可正确下载
    const name = String(file.name || '').replace(/[\r\n\\]+/g, ' ');
    const mimeType = /^[\w.+-]+\/[\w.+-]+$/.test(String(file.type || '')) ? file.type : 'application/octet-stream';
    response.writeHead(200, {
        'Content-Type': mimeType,
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Cache-Control': 'no-store'
    });
    response.end(file.bytes);
}

// 会话 Cookie：仅本机 HTTP 原型，故不设 Secure / Domain；DB 只存哈希，token 只在 Cookie 中出现
const SESSION_COOKIE = 'sidereal_session';
const SESSION_COOKIE_PATTERN = /(?:^|;\s*)sidereal_session=([0-9a-f]{64})(?:;|$)/;
const cookieBaseAttrs = 'HttpOnly; SameSite=Strict; Path=/';

function setSessionCookie(token) {
    return `${SESSION_COOKIE}=${token}; ${cookieBaseAttrs}; Max-Age=604800`;
}

function clearSessionCookie() {
    return `${SESSION_COOKIE}=; ${cookieBaseAttrs}; Max-Age=0`;
}

// 只接受 64 位十六进制 token 的 cookie；畸形 cookie 静默忽略，绝不 throw
function readSessionToken(request) {
    const header = request.headers.cookie;
    if (typeof header !== 'string') return null;
    const match = header.match(SESSION_COOKIE_PATTERN);
    return match ? match[1] : null;
}

// setup/register/login 三端点共享的固定窗口限流：30 次/分钟
const authLimit = { start: Date.now(), count: 0 };
function checkAuthRate() {
    const now = Date.now();
    if (now - authLimit.start >= 60000) {
        authLimit.start = now;
        authLimit.count = 0;
    }
    authLimit.count += 1;
    if (authLimit.count > 30) throw fail(429, '尝试过于频繁，请稍后再试');
}

// 防止同浏览器切换账号后旧页面把草稿保存给新账号：
// 写请求必须带头并匹配当前会话；GET 允许缺失（附件 anchor），带了就必须一致
function checkStudioUser(request, user, required) {
    const raw = request.headers['x-studio-user'];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value == null || value === '') {
        if (required) throw fail(400, '缺少 X-Studio-User 请求头');
        return;
    }
    if (value !== user.id) throw fail(403, '登录账号已在其他窗口切换，请重新登录；未保存内容仍保留');
}

async function handleApi(request, response, pathname) {
    if (!originAllowed(request)) throw fail(403, 'Access denied');
    const method = request.method;
    if (pathname === '/api/health') {
        if (method !== 'GET') throw fail(405, 'Method not allowed', 'GET');
        return sendJson(response, 200, { ok: true });
    }
    // ---- 账号接口（匿名可访问，同本机 Host/Origin 检查，不开放 CORS）----
    let match = pathname.match(/^\/api\/auth\/(me|setup|register|login|logout|password)$/);
    if (match) {
        const action = match[1];
        if (action === 'me') {
            if (method !== 'GET') throw fail(405, 'Method not allowed', 'GET');
            const token = readSessionToken(request);
            const user = token ? await store.auth.current(token) : null;
            const authStatus = store.auth.status();
            return sendJson(response, 200, { user, needsSetup: authStatus.needsSetup, legacyDraftCount: authStatus.legacyDraftCount });
        }
        // 修改密码：登录即需 POST，走独立的凭证检查；匿名或 405 不走通用限流。
        if (action === 'password') {
            if (method !== 'POST') throw fail(405, 'Method not allowed', 'POST');
            const token = readSessionToken(request);
            if (!token) throw fail(401, '请先登录');
            const user = await store.auth.current(token);
            if (!user) throw fail(401, '请先登录');
            checkStudioUser(request, user, true);
            checkAuthRate();
            const payload = await readJson(request, authBodyMaxBytes);
            await store.auth.changePassword(token, payload.currentPassword, payload.newPassword);
            // 已改使全部 session 失效，通知调用端清除本 cookie
            return sendJson(response, 200, { changed: true }, { 'Set-Cookie': clearSessionCookie() });
        }
        if (method !== 'POST') throw fail(405, 'Method not allowed', 'POST');
        if (action === 'logout') {
            // 没有会话也返回 204
            const token = readSessionToken(request);
            if (token) await store.auth.logout(token);
            return response.writeHead(204, { 'Cache-Control': 'no-store', 'Set-Cookie': clearSessionCookie() }).end();
        }
        const oldToken = readSessionToken(request);
        checkAuthRate();
        const payload = await readJson(request, authBodyMaxBytes);
        // 成功后注销旧 cookie 对应会话，新 token 不与旧 token 并存
        let result;
        if (action === 'setup') result = await store.auth.setup(payload.username, payload.password, payload.claimLegacy);
        else if (action === 'register') result = await store.auth.register(payload.username, payload.password);
        else result = await store.auth.login(payload.username, payload.password);
        if (oldToken) await store.auth.logout(oldToken);
        return sendJson(response, action === 'login' ? 200 : 201, { user: result.user }, { 'Set-Cookie': setSessionCookie(result.token) });
    }
    // ---- 草稿接口：必须先登录；公开列表/公开下载不在 /api/drafts 下 ----
    let currentUser = null;
    if (/^\/api\/drafts(\/|$)/.test(pathname)) {
        const token = readSessionToken(request);
        currentUser = token ? await store.auth.current(token) : null;
        if (!currentUser) throw fail(401, '请先登录');
        checkStudioUser(request, currentUser, method === 'PUT' || method === 'DELETE');
    }
    if (/^\/api\/drafts\/?$/.test(pathname)) {
        if (method !== 'GET') throw fail(405, 'Method not allowed', 'GET');
        return sendJson(response, 200, store.list(currentUser.id));
    }
    match = pathname.match(/^\/api\/drafts\/([^/]+)$/);
    if (match) {
        const id = match[1];
        if (method === 'GET') {
            const dto = store.get(id, currentUser.id);
            if (!dto) throw fail(404, '草稿不存在');
            return sendJson(response, 200, dto);
        }
        if (method === 'PUT') {
            const body = await readBody(request);
            const parsed = await parseMultipart(body, request.headers['content-type']);
            const updated = store.save(id, parsed.metadata, parsed.uploadedFile, currentUser.id);
            return sendJson(response, updated.revision === 1 ? 201 : 200, updated);
        }
        if (method === 'DELETE') {
            const payload = await readJson(request);
            store.remove(id, payload.expectedVersion, currentUser.id);
            return response.writeHead(204, { 'Cache-Control': 'no-store' }).end();
        }
        throw fail(405, 'Method not allowed', 'GET, PUT, DELETE');
    }
    match = pathname.match(/^\/api\/drafts\/([^/]+)\/publication$/);
    if (match) {
        const id = match[1];
        // 发布/撤回：带期望版本号防止旧窗口误操作，成功后返回最新完整草稿 DTO
        if (method === 'PUT') {
            const payload = await readJson(request);
            return sendJson(response, 200, store.publish(id, payload.expectedVersion, currentUser.id));
        }
        if (method === 'DELETE') {
            const payload = await readJson(request);
            return sendJson(response, 200, store.unpublish(id, payload.expectedPublishedVersion, currentUser.id));
        }
        throw fail(405, 'Method not allowed', 'PUT, DELETE');
    }
    match = pathname.match(/^\/api\/drafts\/([^/]+)\/versions\/(\d+)\/file$/);
    if (match) {
        if (method !== 'GET') throw fail(405, 'Method not allowed', 'GET');
        const file = store.getFile(match[1], Number(match[2]), currentUser.id);
        if (!file) throw fail(404, '该版本没有附件');
        return sendAttachment(response, file);
    }
    match = pathname.match(/^\/api\/drafts\/([^/]+)\/backup$/);
    if (match) {
        if (method !== 'GET') throw fail(405, 'Method not allowed', 'GET');
        const id = match[1];
        const dir = await fs.promises.mkdtemp(path.join(dataDir, '.backup-'));
        try {
            const filePath = path.join(dir, 'archive.studio-backup');
            store.exportBackup(id, filePath, currentUser.id);
            const size = (await fs.promises.stat(filePath)).size;
            const safeId = String(id).replace(/[^\w-]+/g, '_');
            response.writeHead(200, {
                'Content-Type': 'application/octet-stream',
                'Content-Disposition': `attachment; filename=sidereal-${safeId}.studio-backup`,
                'Cache-Control': 'no-store',
                'Content-Length': String(size)
            });
            await pipeline(fs.createReadStream(filePath), response);
        } finally {
            await fs.promises.rm(dir, { recursive: true, force: true });
        }
        return;
    }
    if (/^\/api\/publications\/?$/.test(pathname)) {
        if (method !== 'GET') throw fail(405, 'Method not allowed', 'GET');
        return sendJson(response, 200, store.listPublications());
    }
    // 匿名单条公开查询：无需登录或 X-Studio-User；校验 id 格式后查当前公开快照
    match = pathname.match(/^\/api\/publications\/([^/]+)$/);
    if (match) {
        if (method !== 'GET') throw fail(405, 'Method not allowed', 'GET');
        const dto = store.getPublication(match[1]);
        if (!dto) throw fail(404, '该草稿不存在或未发布');
        return sendJson(response, 200, dto);
    }
    match = pathname.match(/^\/api\/publications\/([^/]+)\/file$/);
    if (match) {
        if (method !== 'GET') throw fail(405, 'Method not allowed', 'GET');
        const file = store.getPublishedFile(match[1]);
        if (!file) throw fail(404, '该草稿未发布或没有附件');
        return sendAttachment(response, file);
    }
    match = pathname.match(/^\/api\/publications\/([^/]+)\/import$/);
    if (match) {
        if (method !== 'POST') throw fail(405, 'Method not allowed', 'POST');
        const token = readSessionToken(request);
        const user = token ? await store.auth.current(token) : null;
        if (!user) throw fail(401, '请先登录');
        checkStudioUser(request, user, true);
        const payload = await readJson(request, authBodyMaxBytes);
        return sendJson(response, 201, store.importPublication(match[1], payload.expectedPublishedVersion, user.id));
    }
    if (pathname === '/api/backups/restore') {
        if (method !== 'POST') throw fail(405, 'Method not allowed', 'POST');
        const token = readSessionToken(request);
        const user = token ? await store.auth.current(token) : null;
        if (!user) throw fail(401, '请先登录');
        checkStudioUser(request, user, true);
        const rawType = request.headers['content-type'];
        const typeValue = Array.isArray(rawType) ? rawType.join(',') : rawType;
        if (!/^application\/octet-stream\s*(?:;|$)/i.test(String(typeValue || ''))) throw fail(400, '必须以 application/octet-stream 提交备份');
        const declared = Number(request.headers['content-length']);
        if (Number.isFinite(declared) && declared > MAX_BACKUP_BYTES) throw fail(413, '备份超过 512MiB');
        const dir = await fs.promises.mkdtemp(path.join(dataDir, '.backup-'));
        let aborted = Boolean(request.aborted);
        const onAbort = () => { aborted = true; };
        request.once('aborted', onAbort);
        try {
            const filePath = path.join(dir, 'archive.studio-backup');
            let total = 0;
            const handle = await fs.promises.open(filePath, 'wx');
            try {
                for await (const chunk of request.iterator({ destroyOnReturn: false })) {
                    total += chunk.length;
                    if (total > MAX_BACKUP_BYTES) {
                        request.pause();
                        throw fail(413, '备份超过 512MiB');
                    }
                    await handle.writeFile(chunk);
                }
            } finally {
                await handle.close();
            }
            if (aborted || (Number.isFinite(declared) && total < declared)) throw fail(400, '连接中断，备份上传不完整');
            const dto = store.restoreBackup(filePath, user.id);
            return sendJson(response, 201, dto);
        } catch (error) {
            if (error && Number.isInteger(error.status)) throw error;
            if (aborted) throw fail(400, '连接中断，备份上传不完整');
            throw error;
        } finally {
            request.off('aborted', onAbort);
            await fs.promises.rm(dir, { recursive: true, force: true });
        }
    }
    throw fail(404, 'API 路由不存在');
}

async function handle(request, response) {
    // Host 必须是本机端口，避免本地服务被其他域名以 Host 方式利用
    if (request.headers.host !== localHost) throw fail(403, 'Access denied');
    const pathname = new URL(request.url, localOrigin).pathname;
    if (pathname.startsWith('/api/')) return handleApi(request, response, pathname);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { Allow: 'GET, HEAD' }).end();
        return;
    }
    if (pathname === '/favicon.ico') return response.writeHead(204).end();
    const file = files.get(pathname);
    if (!file) return response.writeHead(404).end('Not found');
    fs.readFile(path.join(root, file[0]), (error, data) => {
        if (error) {
            response.writeHead(error.code === 'ENOENT' ? 404 : 500).end(error.code === 'ENOENT' ? 'Not found' : 'Unable to read page');
            return;
        }
        response.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-store' });
        response.end(request.method === 'HEAD' ? undefined : data);
    });
}

const server = http.createServer((request, response) => {
    handle(request, response).catch(error => {
        const status = error && Number.isInteger(error.status) ? error.status : 500;
        // 500 统一隐藏内部细节：不暴露本机路径或 SQL 信息
        const message = status === 500 ? '服务器内部错误' : (error && error.message) || '服务器内部错误';
        try {
            if (!response.headersSent) {
                const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
                if (error && error.allow) headers.Allow = error.allow;
                response.writeHead(status, headers);
                response.end(JSON.stringify({ error: message }));
            } else {
                response.end();
            }
        } catch { /* 响应通道已断开时忽略 */ }
        if (status === 413) request.socket.end();
        else request.resume();
        if (status === 500) console.error(error instanceof Error ? error.message : String(error));
    });
});

function shutdown() {
    try { server.close(); } catch { /* 忽略重复关闭 */ }
    try { store.close(); } catch { /* 忽略重复关闭 */ }
}

server.on('error', error => {
    console.error(error.message);
    process.exit(1);
});
process.on('SIGINT', () => { shutdown(); process.exit(0); });
process.on('SIGTERM', () => { shutdown(); process.exit(0); });
server.listen(port, '127.0.0.1', () => console.log(`Content Studio: http://127.0.0.1:${port}`));
