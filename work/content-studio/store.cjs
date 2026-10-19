// store.cjs：本地 SQLite 存储层，drafts 表存草稿，versions 表存全部历史版本
// 每个草稿必须归属某个用户（draft_owners），未传 userId 的调用一律拒绝
const { DatabaseSync } = require('node:sqlite');
const { randomUUID } = require('node:crypto');
const { createAuth } = require('./auth.cjs');

const CATEGORIES = ['law', 'notes', 'questions'];
const ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

// 公开版本 SELECT：列表与单条查询共用，保证两边字段一致；LEFT JOIN 保留未认领草稿（publisher 为 null）
const PUBLISHED_SELECT = 'SELECT p.draftId AS id, p.version, p.publishedAt, v.title, v.description, v.category, v.fileName, v.fileType, LENGTH(v.fileData) AS fileSize, u.username AS publisher FROM publications p JOIN versions v ON v.draftId = p.draftId AND v.version = p.version LEFT JOIN draft_owners o ON o.draftId = p.draftId LEFT JOIN users u ON u.id = o.userId';

function fail(status, message) {
    const error = new Error(message);
    error.status = status;
    return error;
}

// 草稿 id 只允许字母、数字、下划线、连字符，长度 1~100
function checkId(id) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw fail(400, '草稿 id 格式不正确');
}

function createStore(dbPath) {
    const db = new DatabaseSync(dbPath);
    // 关联删除 CASCADE：删除草稿时连带删除其历史版本
    db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS drafts (
            id TEXT PRIMARY KEY,
            createdAt TEXT NOT NULL,
            currentVersion INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS versions (
            draftId TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
            version INTEGER NOT NULL,
            savedAt TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT,
            category TEXT NOT NULL,
            fileName TEXT,
            fileType TEXT,
            fileData BLOB,
            PRIMARY KEY (draftId, version)
        );
        -- 公共快照：每个草稿至多一条，version 指向 versions 中已保存的版本；删除草稿时 CASCADE 连带撤回
        CREATE TABLE IF NOT EXISTS publications (
            draftId TEXT PRIMARY KEY REFERENCES drafts(id) ON DELETE CASCADE,
            version INTEGER NOT NULL,
            publishedAt TEXT NOT NULL
        );
    `);
    // 业务表建完后接入账号体系：auth.cjs 在同一连接上建 users/sessions/draft_owners
    const auth = createAuth(db);

    const statements = {
        // 归属语句：草稿只能被其所有者读写
        owner: db.prepare('SELECT userId FROM draft_owners WHERE draftId = ?'),
        insertOwner: db.prepare('INSERT INTO draft_owners (draftId, userId) VALUES (?, ?)'),
        ownedIds: db.prepare('SELECT d.id FROM drafts d JOIN draft_owners o ON o.draftId = d.id WHERE o.userId = ?'),
        draft: db.prepare('SELECT id, createdAt, currentVersion FROM drafts WHERE id = ?'),
        current: db.prepare('SELECT currentVersion FROM drafts WHERE id = ?'),
        versions: db.prepare('SELECT version, savedAt, title, description, category, fileName, fileType, LENGTH(fileData) AS fileSize FROM versions WHERE draftId = ? ORDER BY version'),
        versionData: db.prepare('SELECT fileName, fileType, fileData FROM versions WHERE draftId = ? AND version = ?'),
        insertDraft: db.prepare('INSERT INTO drafts (id, createdAt, currentVersion) VALUES (?, ?, 0)'),
        insertVersion: db.prepare('INSERT INTO versions (draftId, version, savedAt, title, description, category, fileName, fileType, fileData) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
        updateDraft: db.prepare('UPDATE drafts SET currentVersion = ? WHERE id = ?'),
        deleteDraft: db.prepare('DELETE FROM drafts WHERE id = ?'),
        publication: db.prepare('SELECT version, publishedAt FROM publications WHERE draftId = ?'),
        insertPublication: db.prepare('INSERT INTO publications (draftId, version, publishedAt) VALUES (?, ?, ?)'),
        deletePublication: db.prepare('DELETE FROM publications WHERE draftId = ?'),
        user: db.prepare('SELECT id FROM users WHERE id = ?'),
        // 直接在 SQL 内复制版本行，避免把大附件读进 JS 再写回
        copyVersion: db.prepare('INSERT INTO versions (draftId, version, savedAt, title, description, category, fileName, fileType, fileData) SELECT ?, 1, ?, title, description, category, fileName, fileType, fileData FROM versions WHERE draftId = ? AND version = ?'),
        // 只读已发布版本本身的元数据；用 JOIN 保证列表不含草稿当前内容、历史版本或 BLOB。
        // 列表与单条查询共用同一 SELECT 串：列表只补 ORDER BY，单条只补 WHERE
        publishedList: db.prepare(PUBLISHED_SELECT + ' ORDER BY p.publishedAt DESC, p.draftId'),
        publishedSingle: db.prepare(PUBLISHED_SELECT + ' WHERE p.draftId = ?')
    };

    function runTransaction(action) {
        // 事务保证原子性：失败回滚，全部成功才提交
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

    // 归属校验：非本人或不存在的草稿一律 404，避免探测他人草稿是否存在
    function requireOwner(id, userId) {
        const row = statements.owner.get(id);
        if (!row || row.userId !== userId) throw fail(404, '草稿不存在');
    }

    function validateMetadata(metadata) {
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw fail(400, 'metadata 必须是对象');
        if (typeof metadata.title !== 'string') throw fail(400, 'title 必须是字符串');
        const title = metadata.title.trim();
        if (!title) throw fail(400, '标题不能为空');
        let description = '';
        if (metadata.description != null) {
            if (typeof metadata.description !== 'string') throw fail(400, 'description 必须是字符串');
            description = metadata.description.trim();
        }
        if (!CATEGORIES.includes(metadata.category)) throw fail(400, 'category 只能是 law/notes/questions');
        const expectedVersion = metadata.expectedVersion;
        if (typeof expectedVersion !== 'number' || !Number.isInteger(expectedVersion) || expectedVersion < 0) throw fail(400, 'expectedVersion 必须是非负整数');
        let attachmentVersion = null;
        if (metadata.attachmentVersion != null) {
            if (typeof metadata.attachmentVersion !== 'number' || !Number.isInteger(metadata.attachmentVersion) || metadata.attachmentVersion < 1) throw fail(400, 'attachmentVersion 不正确');
            attachmentVersion = metadata.attachmentVersion;
        }
        return { title, description, category: metadata.category, expectedVersion, attachmentVersion };
    }

    function validateUpload(uploadedFile) {
        if (uploadedFile == null) return null;
        if (typeof uploadedFile !== 'object' || !Buffer.isBuffer(uploadedFile.bytes)) throw fail(400, '附件数据不正确');
        return {
            name: typeof uploadedFile.name === 'string' ? uploadedFile.name : '',
            type: typeof uploadedFile.type === 'string' ? uploadedFile.type : '',
            bytes: uploadedFile.bytes
        };
    }

    function fileMeta(draftId, version, name, type, size) {
        // url 指向该版本附件的下载接口
        return { name, type, size, version, url: '/api/drafts/' + draftId + '/versions/' + version + '/file' };
    }

    // 组装 DTO：只含元数据，不含 BLOB/base64
    function buildDto(draftId) {
        const draft = statements.draft.get(draftId);
        if (!draft) return null;
        const rows = statements.versions.all(draftId);
        const versions = rows.map(row => ({
            version: row.version,
            savedAt: row.savedAt,
            title: row.title,
            description: row.description,
            category: row.category,
            file: row.fileSize != null ? fileMeta(draftId, row.version, row.fileName, row.fileType, row.fileSize) : null
        }));
        const current = versions.find(item => item.version === draft.currentVersion);
        const publication = statements.publication.get(draftId);
        return {
            id: draftId,
            createdAt: draft.createdAt,
            updatedAt: rows.length ? rows[rows.length - 1].savedAt : draft.createdAt,
            revision: draft.currentVersion,
            title: current.title,
            description: current.description,
            category: current.category,
            file: current.file,
            versions,
            // publication表示公开快照；保存草稿新版本不会改动它
            publication: publication ? { version: publication.version, publishedAt: publication.publishedAt } : null
        };
    }

    // 列表只返回本人归属的草稿
    function list(userId) {
        const items = statements.ownedIds.all(userId).map(row => buildDto(row.id));
        // 最近更新在前；同时刻按创建时间与 id 排序保证稳定
        return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    }

    // 非本人或缺失一律返回 null
    function get(id, userId) {
        if (typeof id !== 'string' || !ID_PATTERN.test(id)) return null;
        const owner = statements.owner.get(id);
        if (!owner || owner.userId !== userId) return null;
        return buildDto(id);
    }

    // 每次保存都创建新版本，不覆盖历史
    function save(id, metadata, uploadedFile, userId) {
        checkId(id);
        const meta = validateMetadata(metadata);
        const upload = validateUpload(uploadedFile);
        return runTransaction(() => {
            const draft = statements.current.get(id);
            // 已有 id 必须本人所有，之后才做原 revision CAS
            if (draft) requireOwner(id, userId);
            if (meta.expectedVersion === 0) {
                if (draft) throw fail(409, '草稿已存在');
            } else {
                if (!draft) throw fail(404, '草稿不存在');
                if (draft.currentVersion !== meta.expectedVersion) throw fail(409, '草稿已在其他窗口修改，请刷新后重试');
            }
            let fileName = null;
            let fileType = null;
            let fileData = null;
            if (upload) {
                fileName = upload.name;
                fileType = upload.type;
                fileData = upload.bytes;
            } else if (meta.attachmentVersion != null) {
                // 无新文件时复用旧版本附件字节；附件名只作为数据，绝不当本机路径
                const source = statements.versionData.get(id, meta.attachmentVersion);
                if (!source) throw fail(400, '附件来源版本不存在');
                if (source.fileData != null) {
                    fileName = source.fileName;
                    fileType = source.fileType;
                    fileData = Buffer.from(source.fileData);
                }
            }
            const savedAt = new Date().toISOString();
            const version = (draft ? draft.currentVersion : 0) + 1;
            if (!draft) {
                statements.insertDraft.run(id, savedAt);
                // 新建草稿同时写入归属
                statements.insertOwner.run(id, userId);
            }
            statements.insertVersion.run(id, version, savedAt, meta.title, meta.description, meta.category, fileName, fileType, fileData);
            statements.updateDraft.run(version, id);
            return buildDto(id);
        });
    }

    function remove(id, expectedVersion, userId) {
        checkId(id);
        if (typeof expectedVersion !== 'number' || !Number.isInteger(expectedVersion) || expectedVersion < 0) throw fail(400, 'expectedVersion 必须是非负整数');
        return runTransaction(() => {
            const draft = statements.current.get(id);
            if (!draft) throw fail(404, '草稿不存在');
            requireOwner(id, userId);
            if (draft.currentVersion !== expectedVersion) throw fail(409, '草稿已在其他窗口修改，请刷新后重试');
            // CASCADE 连带删除全部历史版本与归属记录
            statements.deleteDraft.run(id);
            return true;
        });
    }

    // 内部读取版本附件字节；供 getFile（先做归属校验）与 getPublishedFile（公开路径）复用
    function readVersionFile(id, version) {
        const row = statements.versionData.get(id, version);
        if (!row || row.fileData == null) return null;
        return { name: row.fileName, type: row.fileType, bytes: Buffer.from(row.fileData) };
    }

    // 返回 {name,type,bytes}；非本人、版本不存在或无附件返回 null
    function getFile(id, version, userId) {
        if (typeof id !== 'string' || !ID_PATTERN.test(id) || !Number.isInteger(version)) return null;
        const owner = statements.owner.get(id);
        if (!owner || owner.userId !== userId) return null;
        return readVersionFile(id, version);
    }

    // 发布：把“当前版本”固定为公开快照；此后保存草稿不再影响公开内容，更新须再次手动发布
    function publish(id, expectedVersion, userId) {
        checkId(id);
        if (typeof expectedVersion !== 'number' || !Number.isInteger(expectedVersion) || expectedVersion < 1) throw fail(400, 'expectedVersion 必须是正整数');
        return runTransaction(() => {
            const draft = statements.current.get(id);
            if (!draft) throw fail(404, '草稿不存在');
            requireOwner(id, userId);
            if (draft.currentVersion !== expectedVersion) throw fail(409, '草稿已在其他窗口修改，请刷新后重试');
            const existing = statements.publication.get(id);
            // 重复发布同一版本保持原 publishedAt；切换版本时才写入新时间
            if (!existing || existing.version !== expectedVersion) {
                statements.deletePublication.run(id);
                statements.insertPublication.run(id, expectedVersion, new Date().toISOString());
            }
            return buildDto(id);
        });
    }

    // 撤回：需带上调用方看到的公开版本号，旧窗口无法撤回他人刚更新的公共版本
    function unpublish(id, expectedPublishedVersion, userId) {
        checkId(id);
        if (typeof expectedPublishedVersion !== 'number' || !Number.isInteger(expectedPublishedVersion) || expectedPublishedVersion < 1) throw fail(400, 'expectedPublishedVersion 必须是正整数');
        return runTransaction(() => {
            const pub = statements.publication.get(id);
            if (!pub) throw fail(404, '该草稿不存在或未发布');
            requireOwner(id, userId);
            if (pub.version !== expectedPublishedVersion) throw fail(409, '公开版本已在其他窗口更新，请刷新后重试');
            statements.deletePublication.run(id);
            return buildDto(id);
        });
    }

    // 导入公共版本为个人草稿：全新 id、revision=1，只有这一个来源快照，publications 完全不参与
    function importPublication(sourceId, expectedPublishedVersion, userId) {
        checkId(sourceId);
        if (typeof expectedPublishedVersion !== 'number' || !Number.isInteger(expectedPublishedVersion) || expectedPublishedVersion < 1) throw fail(400, 'expectedPublishedVersion 必须是正整数');
        if (typeof userId !== 'string' || !userId || !statements.user.get(userId)) throw fail(400, 'userId 必须是有效用户');
        return runTransaction(() => {
            const pub = statements.publication.get(sourceId);
            if (!pub) throw fail(404, '该草稿不存在或未发布');
            if (pub.version !== expectedPublishedVersion) throw fail(409, '公共版本已更新，请刷新公共列表后重试');
            const draftId = randomUUID();
            const savedAt = new Date().toISOString();
            statements.insertDraft.run(draftId, savedAt);
            statements.insertOwner.run(draftId, userId);
            const copied = statements.copyVersion.run(draftId, savedAt, sourceId, pub.version);
            if (copied.changes !== 1) throw fail(404, '该草稿不存在或未发布');
            statements.updateDraft.run(1, draftId);
            return buildDto(draftId);
        });
    }

    // 公开 DTO 映射：列表与单条共用，只含元数据字段，不含 BLOB
    function mapPublication(row) {
        return {
            id: row.id,
            version: row.version,
            publishedAt: row.publishedAt,
            title: row.title,
            description: row.description,
            category: row.category,
            publisher: row.publisher || null,
            file: row.fileSize != null ? { name: row.fileName, type: row.fileType, size: row.fileSize, url: '/api/publications/' + row.id + '/file' } : null
        };
    }

    // 公开列表：最近发布在前
    function listPublications() {
        return statements.publishedList.all().map(mapPublication);
    }

    // 匿名单条公开查询：仅按 publications 当前快照取一行；缺失/未发布返回 null，绝无写操作
    function getPublication(id) {
        checkId(id);
        const row = statements.publishedSingle.get(id);
        return row ? mapPublication(row) : null;
    }

    // 公开下载：只按当前 publication.version 取附件，公开 URL 不接受 version 参数；
    // 公开路径走 readVersionFile，不被归属校验误伤
    function getPublishedFile(id) {
        const pub = statements.publication.get(id);
        if (!pub) return null;
        return readVersionFile(id, pub.version);
    }

    function close() {
        db.close();
    }

    return { auth, list, get, save, remove, getFile, publish, unpublish, importPublication, listPublications, getPublication, getPublishedFile, close };
}

module.exports = { createStore };
