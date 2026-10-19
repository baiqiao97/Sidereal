'use strict';

// Complete draft backup module (Node 22 built-ins only: node:sqlite + node:fs + node:crypto).
// writeDraftBackup: export an owned draft to a fresh backup file (backup_info + versions tables).
// restoreDraftBackup: validate a backup file against the exact schema/limits, then import all
// versions into the main database under a newly generated UUID draft id, inside one transaction
// that rolls back completely on failure. Validation errors surface as HTTP 400/413 via err.status;
// main-database failures propagate as 500 to the caller's HTTP wrapper.

const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const MAX_BACKUP_BYTES = 512 * 1024 * 1024; // whole-file cap, re-checked after close
const MAX_FILE_BYTES = 50 * 1024 * 1024; // per attached file
const MAX_TITLE_LEN = 16384;
const MAX_DESCRIPTION_LEN = 1048576;
const MAX_FILE_NAME_LEN = 4096;
const MAX_FILE_TYPE_LEN = 256;
const MAX_VERSIONS = 10000;
const MAX_META_CHARS = 16 * 1024 * 1024; // aggregate cap over all text metadata per backup
const CATEGORIES = new Set(['law', 'notes', 'questions']);
const BACKUP_FORMAT = 'sidereal-draft-backup';
const BACKUP_FORMAT_VERSION = 1;

// Destination schemas; reused later for restore/import validation.
const INFO_SQL =
  'CREATE TABLE backup_info (format TEXT NOT NULL, formatVersion INTEGER NOT NULL, ' +
  'createdAt TEXT NOT NULL, currentVersion INTEGER NOT NULL) STRICT';
const VERSIONS_SQL =
  'CREATE TABLE versions (version INTEGER PRIMARY KEY, savedAt TEXT NOT NULL, title TEXT NOT NULL, ' +
  'description TEXT NOT NULL, category TEXT NOT NULL, fileName TEXT, fileType TEXT, fileData BLOB) STRICT';

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Canonical ISO 8601 UTC timestamp that survives a Date round-trip.
function validIsoDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(v)) return false;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return false;
  return new Date(t).toISOString() === v || new Date(t).toISOString().replace(/\.000Z$/, 'Z') === v;
}

// Validates one version row against its expected sequence number. Accepts a metadata
// row (fileKind/fileSize computed in SQL, no BLOB transferred) or a full row (real Buffer).
function validateVersion(v, expected) {
  if (!v || v.version !== expected) throw fail(400, 'versions not sequential');
  if (!validIsoDate(v.savedAt)) throw fail(400, 'invalid savedAt timestamp');
  if (typeof v.title !== 'string' || v.title.trim() === '') throw fail(400, 'invalid title');
  if (v.description !== null && typeof v.description !== 'string') throw fail(400, 'invalid description');
  if (!CATEGORIES.has(v.category)) throw fail(400, 'invalid category');
  const kind = v.fileKind !== undefined ? v.fileKind : (v.fileData == null ? 'null' : 'blob');
  const size = v.fileData != null ? v.fileData.length : v.fileSize;
  if (v.fileName === null) {
    if (v.fileType !== null || kind !== 'null') throw fail(400, 'inconsistent file metadata');
    return;
  }
  if (typeof v.fileName !== 'string' || typeof v.fileType !== 'string') throw fail(400, 'invalid file metadata');
  if (kind !== 'blob') throw fail(400, 'invalid file data');
  if (!Number.isInteger(size) || size < 0 || size > MAX_FILE_BYTES) throw fail(413, 'attached file too large');
}

// Exports draft `id` (ownership already verified by caller) to a brand-new backup file.
// Source rows are never written. Caller owns deleting the destination file on error.
function writeDraftBackup(db, id, filePath) {
  if (db == null || typeof db !== 'object') throw fail(400, 'invalid database handle');
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw fail(400, 'invalid draft id');
  if (typeof filePath !== 'string' || filePath === '') throw fail(400, 'invalid backup path');

  let srcTxn = false; // source read transaction
  let dest = null; // destination database
  let destTxn = false; // destination write transaction
  try {
    db.exec('BEGIN'); // read snapshot: counts/checks see the same rows the copy reads
    srcTxn = true;

    const draft = db.prepare('SELECT createdAt, currentVersion FROM drafts WHERE id = ?').get(id);
    if (!draft) throw fail(404, 'draft not found');
    if (!validIsoDate(draft.createdAt)) throw fail(400, 'invalid draft createdAt');
    const n = draft.currentVersion;
    if (!Number.isInteger(n) || n < 1 || n > MAX_VERSIONS) throw fail(400, 'invalid currentVersion');

    // SQL bounds precheck: reject oversized text/blob fields BEFORE transferring any row.
    const b = db.prepare(
      `SELECT COUNT(*) AS cnt, COALESCE(MIN(version), 0) AS minV, COALESCE(MAX(version), 0) AS maxV,
              COALESCE(MAX(LENGTH(title)), 0) AS titleMax,
              COALESCE(MAX(LENGTH(COALESCE(description, ''))), 0) AS descMax,
              COALESCE(MAX(CASE WHEN fileName IS NULL THEN 0 ELSE LENGTH(fileName) END), 0) AS nameMax,
              COALESCE(MAX(CASE WHEN fileType IS NULL THEN 0 ELSE LENGTH(fileType) END), 0) AS typeMax,
              COALESCE(MAX(LENGTH(savedAt)), 0) AS savedAtMax,
              COALESCE(MAX(LENGTH(category)), 0) AS categoryMax,
              COALESCE(MAX(CASE WHEN fileData IS NULL THEN 0 ELSE LENGTH(fileData) END), 0) AS blobMax,
              COALESCE(SUM(LENGTH(title) + LENGTH(COALESCE(description, '')) + LENGTH(savedAt) + LENGTH(category) +
                           LENGTH(COALESCE(fileName, '')) + LENGTH(COALESCE(fileType, ''))), 0) AS metaSum
         FROM versions WHERE draftId = ?`
    ).get(id);
    if (b.cnt !== n) throw fail(400, 'version count mismatch');
    if (b.minV !== 1 || b.maxV !== n) throw fail(400, 'versions not sequential');
    if (b.titleMax > MAX_TITLE_LEN || b.descMax > MAX_DESCRIPTION_LEN) throw fail(413, 'draft text too large');
    if (b.savedAtMax > 32 || b.categoryMax > 16) throw fail(413, 'draft text too large');
    if (b.nameMax > MAX_FILE_NAME_LEN || b.typeMax > MAX_FILE_TYPE_LEN) throw fail(413, 'file metadata too large');
    if (b.blobMax > MAX_FILE_BYTES) throw fail(413, 'attached file too large');
    if (b.metaSum > MAX_META_CHARS) throw fail(413, '元数据总量过大');

    // Metadata pass: every row validated; file summarized via typeof/LENGTH, no BLOB fetched.
    const metaStmt = db.prepare(
      `SELECT version, savedAt, title, description, category, fileName, fileType,
              typeof(fileData) AS fileKind, LENGTH(fileData) AS fileSize
         FROM versions WHERE draftId = ? ORDER BY version`
    );
    let expected = 1;
    for (const row of metaStmt.iterate(id)) {
      validateVersion(row, expected);
      expected++;
    }
    if (expected - 1 !== n) throw fail(400, 'version count mismatch');

    // Reserve destination exclusively; never overwrite an existing file.
    let fd;
    try {
      fd = fs.openSync(filePath, 'wx');
    } catch (openErr) {
      throw fail(openErr && openErr.code === 'EEXIST' ? 409 : 500, 'cannot create backup file');
    }
    fs.closeSync(fd);

    dest = new DatabaseSync(filePath);
    dest.exec(INFO_SQL);
    dest.exec(VERSIONS_SQL);
    dest.exec('BEGIN');
    destTxn = true;
    dest.prepare('INSERT INTO backup_info (format, formatVersion, createdAt, currentVersion) VALUES (?, ?, ?, ?)')
      .run(BACKUP_FORMAT, BACKUP_FORMAT_VERSION, draft.createdAt, n);

    // Copy pass: all versions of this draft only, one row at a time, parameterized inserts.
    const copyStmt = db.prepare(
      `SELECT version, savedAt, title, description, category, fileName, fileType, fileData
         FROM versions WHERE draftId = ? ORDER BY version`
    );
    const insStmt = dest.prepare(
      `INSERT INTO versions (version, savedAt, title, description, category, fileName, fileType, fileData)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    let copied = 1;
    for (const row of copyStmt.iterate(id)) {
      validateVersion(row, copied); // re-check with the actual BLOB in hand
      copied++;
      insStmt.run(row.version, row.savedAt, row.title,
        row.description === null ? '' : row.description, // legacy null description -> ''
        row.category, row.fileName, row.fileType, row.fileData);
    }
    if (copied - 1 !== n) throw fail(400, 'version count mismatch');

    dest.exec('COMMIT');
    destTxn = false;
    dest.close();
    dest = null;

    const { size } = fs.statSync(filePath);
    if (size > MAX_BACKUP_BYTES) throw fail(413, 'backup exceeds maximum allowed size');
  } catch (err) {
    if (destTxn && dest) {
      try { dest.exec('ROLLBACK'); } catch { /* destination already unusable */ }
    }
    if (err && typeof err === 'object' && !('status' in err)) err.status = 500;
    throw err;
  } finally {
    if (dest) {
      try { dest.close(); } catch { /* already closed */ }
    }
    if (srcTxn) {
      try { db.exec('ROLLBACK'); } catch { /* source is read-only here */ }
    }
  }
}

const BAD_BACKUP = '备份文件无效或已损坏，无法导入';

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim().replace(/;$/, '');
}

// Imports a previously exported backup file as a brand-new draft owned by `userId`
// (user existence verified by caller). Returns the new draft id (randomUUID string).
// Acts only through validation + inserts; never deletes or overwrites existing data.
function restoreDraftBackup(db, filePath, userId) {
  if (db == null || typeof db !== 'object') throw fail(400, 'invalid database handle');
  if (typeof filePath !== 'string' || filePath === '') throw fail(400, 'invalid backup path');
  if (typeof userId !== 'string' || userId === '') throw fail(400, 'invalid user');

  // ---- Validation phase: source file stays read-only and closed on any failure. ----
  let stat;
  try { stat = fs.statSync(filePath); } catch { throw fail(400, BAD_BACKUP); }
  if (stat.size > MAX_BACKUP_BYTES) throw fail(413, '备份文件过大');

  let source;
  try {
    source = new DatabaseSync(filePath, { readOnly: true, allowExtension: false });
    source.exec('PRAGMA trusted_schema = OFF');
  } catch {
    if (source) { try { source.close(); } catch { /* ignore */ } }
    throw fail(400, BAD_BACKUP);
  }

  try {
    let rows;
    try { rows = source.prepare("SELECT type, name, LENGTH(sql) AS sqlLength FROM sqlite_schema WHERE name IN ('backup_info','versions')").all(); } catch { throw fail(400, BAD_BACKUP); }
    if (rows.length !== 2) throw fail(400, BAD_BACKUP);
    for (const r of rows) {
      if (r.type !== 'table') throw fail(400, BAD_BACKUP);
      if (r.name !== 'backup_info' && r.name !== 'versions') throw fail(400, BAD_BACKUP);
      if (!Number.isInteger(r.sqlLength) || r.sqlLength > 4096) throw fail(400, BAD_BACKUP);
    }
    rows = source.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name IN ('backup_info','versions')").all();
    for (const r of rows) {
      const sql = normalizeSql(r.sql);
      if (r.name === 'backup_info') { if (sql !== normalizeSql(INFO_SQL)) throw fail(400, BAD_BACKUP); }
      else if (r.name === 'versions') { if (sql !== normalizeSql(VERSIONS_SQL)) throw fail(400, BAD_BACKUP); }
      else throw fail(400, BAD_BACKUP);
    }
    // Any extra schema object (views, triggers, other tables) is rejected.
    const nObj = source.prepare('SELECT COUNT(*) AS c FROM sqlite_schema').get();
    if (!nObj || nObj.c !== 2) throw fail(400, BAD_BACKUP);
    let qcheck;
    try { qcheck = source.prepare('PRAGMA quick_check').get(); } catch { throw fail(400, BAD_BACKUP); }
    if (!qcheck || qcheck.quick_check !== 'ok') throw fail(400, BAD_BACKUP);

    let infoBounds;
    try {
      infoBounds = source.prepare('SELECT COUNT(*) AS c, MAX(LENGTH(format)) AS fmtMax, MAX(LENGTH(createdAt)) AS createdMax FROM backup_info').get();
    } catch { throw fail(400, BAD_BACKUP); }
    if (!infoBounds || infoBounds.c !== 1) throw fail(400, BAD_BACKUP);
    if (infoBounds.fmtMax > 64 || infoBounds.createdMax > 32) throw fail(400, BAD_BACKUP);

    let info;
    try {
      info = source.prepare('SELECT format, formatVersion, createdAt, currentVersion FROM backup_info').all();
    } catch { throw fail(400, BAD_BACKUP); }
    if (info.length !== 1) throw fail(400, BAD_BACKUP);
    if (info[0].format !== BACKUP_FORMAT || info[0].formatVersion !== BACKUP_FORMAT_VERSION) throw fail(400, BAD_BACKUP);
    if (!validIsoDate(info[0].createdAt)) throw fail(400, BAD_BACKUP);
    const n = info[0].currentVersion;
    if (!Number.isInteger(n) || n < 1 || n > MAX_VERSIONS) throw fail(400, BAD_BACKUP);

    // SQL aggregate bounds: counts/sequence and per-row size caps before any BLOB is read.
    let b;
    try {
      b = source.prepare(
        `SELECT COUNT(*) AS cnt, COALESCE(MIN(version), 0) AS minV, COALESCE(MAX(version), 0) AS maxV,
                COALESCE(MAX(LENGTH(title)), 0) AS titleMax,
                COALESCE(MAX(LENGTH(description)), 0) AS descMax,
                COALESCE(MAX(CASE WHEN fileName IS NULL THEN 0 ELSE LENGTH(fileName) END), 0) AS nameMax,
                COALESCE(MAX(CASE WHEN fileType IS NULL THEN 0 ELSE LENGTH(fileType) END), 0) AS typeMax,
                COALESCE(MAX(LENGTH(savedAt)), 0) AS savedAtMax,
                COALESCE(MAX(LENGTH(category)), 0) AS categoryMax,
                COALESCE(MAX(CASE WHEN fileData IS NULL THEN 0 ELSE LENGTH(fileData) END), 0) AS blobMax,
                COALESCE(SUM(LENGTH(title) + LENGTH(COALESCE(description, '')) + LENGTH(savedAt) + LENGTH(category) +
                             LENGTH(COALESCE(fileName, '')) + LENGTH(COALESCE(fileType, ''))), 0) AS metaSum
           FROM versions`
      ).get();
    } catch { throw fail(400, BAD_BACKUP); }
    if (b.cnt !== n || b.minV !== 1 || b.maxV !== n) throw fail(400, BAD_BACKUP);
    if (b.titleMax > MAX_TITLE_LEN) throw fail(413, '草稿文本过大');
    if (b.descMax > MAX_DESCRIPTION_LEN) throw fail(413, '草稿文本过大');
    if (b.savedAtMax > 32 || b.categoryMax > 16) throw fail(413, '元数据总量过大');
    if (b.nameMax > MAX_FILE_NAME_LEN || b.typeMax > MAX_FILE_TYPE_LEN) throw fail(413, '文件元数据过大');
    if (b.blobMax > MAX_FILE_BYTES) throw fail(413, '附件文件过大');
    if (b.metaSum > MAX_META_CHARS) throw fail(413, '元数据总量过大');

    // Metadata pass: no BLOBs transferred; rows checked one at a time in sequence order.
    const metaStmt = source.prepare(
      `SELECT version, savedAt, title, description, category, fileName, fileType,
              typeof(fileData) AS fileKind, LENGTH(fileData) AS fileSize
         FROM versions ORDER BY version`
    ).iterate();
    let expected = 1;
    for (const row of metaStmt) {
      try { validateVersion(row, expected); } catch {
        if (row && (row.fileSize ?? 0) > MAX_FILE_BYTES) throw fail(413, '附件文件过大');
        throw fail(400, BAD_BACKUP);
      }
      if (typeof row.description !== 'string') throw fail(400, BAD_BACKUP); // export always writes ''
      expected++;
    }
    if (expected - 1 !== n) throw fail(400, BAD_BACKUP);

    // ---- Mutation phase: one all-or-nothing transaction on the main database. ----
    const newId = randomUUID();
    db.exec('BEGIN');
    try {
      db.prepare('INSERT INTO drafts (id, createdAt, currentVersion) VALUES (?, ?, 0)')
        .run(newId, info[0].createdAt);
      db.prepare('INSERT INTO draft_owners (draftId, userId) VALUES (?, ?)').run(newId, userId);

      const copy = source.prepare(
        `SELECT version, savedAt, title, description, category, fileName, fileType, fileData
           FROM versions ORDER BY version`
      ).iterate();
      const ins = db.prepare(
        `INSERT INTO versions (draftId, version, savedAt, title, description, category, fileName, fileType, fileData)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      let copied = 1;
      for (const row of copy) {
        validateVersion(row, copied); // re-check with the actual BLOB in hand
        copied++;
        ins.run(newId, row.version, row.savedAt, row.title,
          row.description === null ? '' : row.description,
          row.category, row.fileName, row.fileType, row.fileData);
      }
      if (copied - 1 !== n) throw fail(400, BAD_BACKUP);
      db.prepare('UPDATE drafts SET currentVersion = ? WHERE id = ?').run(n, newId);
      db.exec('COMMIT');
      return newId;
    } catch (txErr) {
      try { db.exec('ROLLBACK'); } catch { /* transaction already gone */ }
      throw txErr; // propagate; HTTP wrapper returns 500 for non-validation errors
    }
  } finally {
    try { source.close(); } catch { /* already closed */ }
  }
}

module.exports = { MAX_BACKUP_BYTES, writeDraftBackup, restoreDraftBackup };
