// auth.cjs：本机原型账号体系（users/sessions/draft_owners），仅服务 127.0.0.1 原型
// createAuth(db) 复用 store 现有 SQLite 连接，不另开数据库
const { scrypt, randomBytes, randomUUID, timingSafeEqual, createHash } = require('node:crypto');
const { promisify } = require('node:util');

const scryptAsync = promisify(scrypt);
// scrypt 参数：N=32768, r=8, p=3；maxmem 放宽到 64MiB 才能容纳该参数组合
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 64;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const USERNAME_PATTERN = /^[a-z0-9_-]{3,32}$/;

function fail(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}

async function hashPassword(password, salt) {
    const bytes = await scryptAsync(password, salt, KEY_LENGTH, SCRYPT_OPTIONS);
    return bytes.toString('hex');
}

// 恒定时间比较，避免逐字节比较的时间侧信道
function safeEqualHex(a, b) {
    const bufA = Buffer.from(a, 'hex');
    const bufB = Buffer.from(b, 'hex');
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
}

function sha256(text) {
    return createHash('sha256').update(text).digest('hex');
}

function createAuth(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT UNIQUE,
            salt TEXT,
            passwordHash TEXT,
            createdAt TEXT
        );
        CREATE TABLE IF NOT EXISTS sessions (
            tokenHash TEXT PRIMARY KEY,
            userId TEXT REFERENCES users(id),
            expiresAt INTEGER
        );
        CREATE TABLE IF NOT EXISTS draft_owners (
            draftId TEXT PRIMARY KEY REFERENCES drafts(id) ON DELETE CASCADE,
            userId TEXT REFERENCES users(id)
        );
    `);

    const statements = {
        countUsers: db.prepare('SELECT COUNT(*) AS c FROM users'),
        userByName: db.prepare('SELECT id, username, salt, passwordHash FROM users WHERE username = ?'),
        insertUser: db.prepare('INSERT INTO users (id, username, salt, passwordHash, createdAt) VALUES (?, ?, ?, ?, ?)'),
        insertSession: db.prepare('INSERT INTO sessions (tokenHash, userId, expiresAt) VALUES (?, ?, ?)'),
        deleteSession: db.prepare('DELETE FROM sessions WHERE tokenHash = ?'),
        deleteExpiredSessions: db.prepare('DELETE FROM sessions WHERE expiresAt <= ?'),
        sessionUser: db.prepare('SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.userId WHERE s.tokenHash = ? AND s.expiresAt > ?'),
        unownedDrafts: db.prepare('SELECT COUNT(*) AS c FROM drafts d LEFT JOIN draft_owners o ON o.draftId = d.id WHERE o.draftId IS NULL'),
        claimUnownedDrafts: db.prepare('INSERT INTO draft_owners (draftId, userId) SELECT d.id, ? FROM drafts d LEFT JOIN draft_owners o ON o.draftId = d.id WHERE o.draftId IS NULL')
    };

    function runTransaction(action) {
        db.exec('BEGIN');
        try {
            const result = action();
            db.exec('COMMIT');
            return result;
        } catch (error) {
            try { db.exec('ROLLBACK'); } catch { /* 回滚失败时让原始错误抛出 */ }
            throw error;
        }
    }

    // 用户名：trim 后转小写再校验；存储统一小写即实现忽略大小写的唯一性
    function normalizeUsername(username) {
        if (typeof username !== 'string') throw fail(400, '用户名格式不正确');
        const name = username.trim().toLowerCase();
        if (!USERNAME_PATTERN.test(name)) throw fail(400, '用户名格式不正确');
        return name;
    }

    // 密码：字符串 12~128 字符，不 trim；绝不写入日志、不在响应中返回
    function validatePassword(password) {
        if (typeof password !== 'string' || password.length < 12 || password.length > 128) throw fail(400, '密码长度必须为 12~128 字符');
    }

    function validateCredentials(username, password) {
        const name = normalizeUsername(username);
        validatePassword(password);
        return name;
    }

    function createSession(userId) {
        const now = Date.now();
        // 建 session 顺手清掉过期 session
        statements.deleteExpiredSessions.run(now);
        const token = randomBytes(32).toString('hex');
        // 数据库只存 SHA256(token)；原文 token 只交给 HTTP 层设置 Cookie，不入库不打日志
        statements.insertSession.run(sha256(token), userId, now + SESSION_TTL_MS);
        return token;
    }

    // 初始化状态：users 为空时报告未被认领的历史草稿数量
    function status() {
        if (statements.countUsers.get().c !== 0) return { needsSetup: false, legacyDraftCount: 0 };
        return { needsSetup: true, legacyDraftCount: statements.unownedDrafts.get().c };
    }

    // 首次初始化唯一入口；存在未归属旧草稿时必须显式 claimLegacy===true 才认领
    async function setup(username, password, claimLegacy) {
        const name = validateCredentials(username, password);
        if (statements.countUsers.get().c !== 0) throw fail(409, '已完成初始化，请直接登录或注册');
        if (statements.unownedDrafts.get().c > 0 && claimLegacy !== true) throw fail(400, '存在未归属的历史草稿，必须确认认领后才能初始化');
        const salt = randomBytes(16).toString('hex');
        const passwordHash = await hashPassword(password, salt);
        return runTransaction(() => {
            // 异步计算 hash 期间可能有并发 setup：事务内再次检查，只允许一个成功
            if (statements.countUsers.get().c !== 0) throw fail(409, '已完成初始化，请直接登录或注册');
            const id = randomUUID();
            statements.insertUser.run(id, name, salt, passwordHash, new Date().toISOString());
            // 历史数据归属第一个用户
            statements.claimUnownedDrafts.run(id);
            const token = createSession(id);
            return { user: { id, username: name }, token };
        });
    }

    // 初始化后注册新用户；未 setup 时一律 409，绝不认领任何旧数据
    async function register(username, password) {
        const name = validateCredentials(username, password);
        if (statements.countUsers.get().c === 0) throw fail(409, '请先完成首次初始化');
        if (statements.userByName.get(name)) throw fail(409, '用户名已存在');
        const salt = randomBytes(16).toString('hex');
        const passwordHash = await hashPassword(password, salt);
        return runTransaction(() => {
            if (statements.userByName.get(name)) throw fail(409, '用户名已存在');
            const id = randomUUID();
            statements.insertUser.run(id, name, salt, passwordHash, new Date().toISOString());
            const token = createSession(id);
            return { user: { id, username: name }, token };
        });
    }

    async function login(username, password) {
        const name = validateCredentials(username, password);
        const user = statements.userByName.get(name);
        if (user) {
            const passwordHash = await hashPassword(password, user.salt);
            if (safeEqualHex(passwordHash, user.passwordHash)) {
                const token = runTransaction(() => createSession(user.id));
                return { user: { id: user.id, username: user.username }, token };
            }
        } else {
            // 未知用户名也执行一次相同成本的 scrypt，避免响应时间差暴露账号是否存在
            await hashPassword(password, randomBytes(16).toString('hex'));
        }
        // 用户名或密码错误统一 401，不区分具体原因
        throw fail(401, '用户名或密码不正确');
    }

    // 会话换用户；无效/过期/非 64 位十六进制一律 null
    function current(token) {
        if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
        const row = statements.sessionUser.get(sha256(token), Date.now());
        return row ? { id: row.id, username: row.username } : null;
    }

    function logout(token) {
        if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return;
        statements.deleteSession.run(sha256(token));
    }

    return { status, setup, register, login, current, logout };
}

module.exports = { createAuth };
