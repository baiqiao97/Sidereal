const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const vm = require('node:vm');
const { createStore } = require('../store.cjs');

const root = path.resolve(__dirname, '..');
const password = 'Only-Synthetic-Backup-Password!';

// Independent of the module internals: must exceed the module's real per-field caps so that
// a length-limit bypass (LENGTH(TEXT) truncating at U+0000) is provable if it still exists.
const MAX_TITLE_LEN_SAFE = 24000;
const MAX_DESCRIPTION_LEN_SAFE = 1_100_000;
const NUL_TITLE = 'ab\u0000' + '大'.repeat(MAX_TITLE_LEN_SAFE); // LENGTH() sees only 2 chars
const MAX_TITLE_CHARS = 16384; // mirrors the module's real caps; NUL tails in tests stay beyond them
const MAX_DESCRIPTION_CHARS = 1048576;
const MAX_FILE_NAME_CHARS = 4096;
const MAX_FILE_TYPE_CHARS = 256;
const ISO_TS = '2026-01-01T00:00:00.000Z';
const metadata = (title, expectedVersion, attachmentVersion) => ({ title, description: '备份简介 <img src=x>', category: 'notes', expectedVersion,
  ...(attachmentVersion ? { attachmentVersion } : {}) });
const rejectsStatus = status => error => error.status === status;

test('backup adapter pins account identity and rejects oversized uploads locally', async () => {
  const requests = [], events = [];
  let status = 200, pending;
  const response = code => ({ status: code, ok: code < 400,
    json: async () => ({ error: 'Synthetic failure', id: 'restored', versions: [] }),
    blob: async () => new Blob(['synthetic backup']) });
  const api = vm.runInNewContext(await fs.readFile(path.join(root, 'server-api.js'), 'utf8') + '\nserverApi;', {
    Headers, Event,
    window: { dispatchEvent: event => events.push(event.type) },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return status === -1 ? new Promise(resolve => { pending = resolve; }) : response(status);
    }
  });
  api.setUser({ id: 'account_a' });
  assert.equal(await (await api.exportBackup('source')).text(), 'synthetic backup');
  assert.equal(requests.at(-1).url, '/api/drafts/source/backup');
  assert.equal(requests.at(-1).options.headers.get('X-Studio-User'), 'account_a');
  const file = new Blob(['synthetic upload']);
  await api.restoreBackup(file);
  assert.equal(requests.at(-1).url, '/api/backups/restore');
  assert.equal(requests.at(-1).options.body, file);
  assert.equal(requests.at(-1).options.headers.get('X-Studio-User'), 'account_a');
  assert.equal(requests.at(-1).options.headers.get('Content-Type'), 'application/octet-stream');
  const count = requests.length;
  await assert.rejects(api.restoreBackup({ size: 512 * 1024 * 1024 + 1 }), /512/);
  assert.equal(requests.length, count);
  status = -1;
  const oldAccount = api.restoreBackup(file);
  api.setUser({ id: 'account_b' }); pending(response(401));
  await assert.rejects(oldAccount, rejectsStatus(401));
  assert.deepEqual(events, []);
  status = 403;
  await assert.rejects(api.exportBackup('source'), rejectsStatus(403));
  assert.deepEqual(events, ['studio-auth-required']);
});

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sidereal-backup-test-'));
  const dbPath = path.join(directory, 'drafts.db');
  const store = createStore(dbPath);
  const lifecycle = { stop: null };
  t.after(async () => {
    if (lifecycle.stop) await lifecycle.stop();
    store.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('sidereal-backup-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const a = await store.auth.setup('backup_owner_a', password, true);
  const b = await store.auth.register('backup_owner_b', password);
  const first = Buffer.from('第一份附件\0原始字节');
  const second = Buffer.from('第二份附件\0更新字节');
  store.save('source', metadata('第一版', 0), { name: '../data/测试.txt', type: 'text/plain', bytes: first }, a.user.id);
  store.save('source', metadata('第二版', 1, 1), null, a.user.id);
  store.publish('source', 2, a.user.id);
  store.save('source', metadata('第三版 <script>literal</script>', 2), { name: '更新.txt', type: 'text/plain', bytes: second }, a.user.id);
  store.save('source', metadata('第四版，无附件', 3), null, a.user.id);
  store.save('private_b', metadata('other-account-private-marker', 0), null, b.user.id);
  return { directory, dbPath, store, a, b, first, second, lifecycle };
}

test('single-draft backups preserve all versions and restore independently', { timeout: 60000 }, async t => {
  const { directory, dbPath, store, a, b, first, second } = await fixture(t);
  const archive = path.join(directory, 'source.studio-backup');
  const original = store.get('source', a.user.id);
  store.exportBackup('source', archive, a.user.id);
  const bytes = await fs.readFile(archive);
  assert.equal(bytes.subarray(0, 16).toString(), 'SQLite format 3\0');
  assert.equal(bytes.includes(Buffer.from('other-account-private-marker')), false);
  assert.equal(bytes.includes(Buffer.from(a.token)), false);
  assert.equal(bytes.includes(Buffer.from(b.token)), false);
  const inspect = new DatabaseSync(archive, { readOnly: true });
  try {
    assert.deepEqual(inspect.prepare('SELECT name FROM sqlite_schema ORDER BY name').all().map(row => row.name), ['backup_info', 'versions']);
    const info = inspect.prepare('SELECT * FROM backup_info').get();
    assert.equal(info.format, 'sidereal-draft-backup');
    assert.equal(info.formatVersion, 1);
    assert.equal(info.currentVersion, 4);
    assert.equal(inspect.prepare('SELECT COUNT(*) AS n FROM versions').get().n, 4);
    assert.deepEqual(Buffer.from(inspect.prepare('SELECT fileData FROM versions WHERE version=1').get().fileData), first);
    assert.deepEqual(Buffer.from(inspect.prepare('SELECT fileData FROM versions WHERE version=2').get().fileData), first);
    assert.deepEqual(Buffer.from(inspect.prepare('SELECT fileData FROM versions WHERE version=3').get().fileData), second);
    assert.equal(inspect.prepare('SELECT fileData FROM versions WHERE version=4').get().fileData, null);
  } finally { inspect.close(); }
  assert.deepEqual(store.get('source', a.user.id), original);
  assert.throws(() => store.exportBackup('source', path.join(directory, 'denied.studio-backup'), b.user.id), rejectsStatus(404));
  assert.throws(() => store.exportBackup('missing', path.join(directory, 'missing.studio-backup'), a.user.id), rejectsStatus(404));
  assert.throws(() => store.exportBackup('source', archive, a.user.id));
  assert.deepEqual(await fs.readFile(archive), bytes, 'existing backup must not be overwritten');
  const restored = store.restoreBackup(archive, b.user.id);
  assert.notEqual(restored.id, original.id);
  assert.equal(restored.revision, 4);
  assert.equal(restored.createdAt, original.createdAt);
  assert.equal(restored.publication, null);
  assert.equal(restored.file, null);
  assert.deepEqual(restored.versions.map(({ file, ...version }) => version), original.versions.map(({ file, ...version }) => version));
  assert.equal(store.get(restored.id, a.user.id), null);
  for (const [version, expected] of [[1, first], [2, first], [3, second]]) assert.deepEqual(store.getFile(restored.id, version, b.user.id).bytes, expected);
  const repeated = store.restoreBackup(archive, b.user.id);
  assert.notEqual(repeated.id, restored.id);
  assert.deepEqual(store.get('source', a.user.id), original);
  store.remove('source', 4, a.user.id);
  assert.deepEqual(store.getFile(restored.id, 1, b.user.id).bytes, first);

  const db = new DatabaseSync(dbPath);
  try {
    const count = db.prepare('SELECT COUNT(*) AS n FROM drafts').get().n;
    db.exec("CREATE TRIGGER reject_restore BEFORE INSERT ON versions BEGIN SELECT RAISE(ABORT,'synthetic insert failure'); END");
    assert.throws(() => store.restoreBackup(archive, a.user.id));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM drafts').get().n, count);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM draft_owners o LEFT JOIN drafts d ON d.id=o.draftId WHERE d.id IS NULL').get().n, 0);
    db.exec('DROP TRIGGER reject_restore');
  } finally { db.close(); }
});

test('invalid archives are rejected before changing account data', { timeout: 60000 }, async t => {
  const { directory, dbPath, store, a, b } = await fixture(t);
  const archive = path.join(directory, 'valid.studio-backup');
  store.exportBackup('source', archive, a.user.id);
  const before = store.list(b.user.id);
  const mutations = [
    "UPDATE backup_info SET formatVersion=2",
    "UPDATE backup_info SET currentVersion=8",
    "UPDATE backup_info SET createdAt='not-a-date'",
    'DELETE FROM versions WHERE version=2',
    "UPDATE versions SET title='   ' WHERE version=1",
    "UPDATE versions SET category='unknown' WHERE version=1",
    "UPDATE versions SET savedAt='not-a-date' WHERE version=1",
    'UPDATE versions SET fileName=NULL WHERE version=1',
    "CREATE TABLE users (passwordHash TEXT)",
    "CREATE TRIGGER extra_trigger BEFORE DELETE ON versions BEGIN SELECT 1; END",
    "DROP TABLE versions; CREATE VIEW versions AS SELECT 1 AS version"
  ];
  for (const [index, sql] of mutations.entries()) {
    const invalid = path.join(directory, 'invalid-' + index + '.studio-backup');
    await fs.copyFile(archive, invalid);
    const db = new DatabaseSync(invalid);
    try { db.exec(sql); } finally { db.close(); }
    assert.throws(() => store.restoreBackup(invalid, b.user.id), rejectsStatus(400), sql);
    assert.deepEqual(store.list(b.user.id), before);
  }
  const invalid = path.join(directory, 'not-sqlite.studio-backup');
  await fs.writeFile(invalid, 'This is not a backup');
  assert.throws(() => store.restoreBackup(invalid, b.user.id), rejectsStatus(400));
  assert.throws(() => store.restoreBackup(dbPath, b.user.id), rejectsStatus(400), 'live database is not an export archive');
  assert.throws(() => store.restoreBackup(archive, 'missing-user'), rejectsStatus(400));
  assert.deepEqual(store.list(b.user.id), before);
});

test('backup HTTP enforces ownership, restore identity and private temporary files', { timeout: 60000 }, async t => {
  const { directory, store, a, b, lifecycle } = await fixture(t);
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, [path.join(root, 'server.cjs'), root, String(port), directory], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  lifecycle.stop = async () => {
    if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
  };
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => reject(new Error('test server exited: ' + code))); child.stdout.once('data', resolve); });
  const headers = who => who ? { Cookie: 'sidereal_session=' + who.token, 'X-Studio-User': who.user.id } : {};
  async function request(who, route, method = 'GET', body, extra = {}) {
    const response = await fetch(base + route, { method, headers: { ...headers(who), ...(body ? { 'Content-Type': 'application/octet-stream' } : {}), ...extra }, body });
    const payload = response.status === 204 || method === 'HEAD' ? null : (response.headers.get('content-type') || '').includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer());
    return { response, payload };
  }
  const exportRoute = '/api/drafts/source/backup', restoreRoute = '/api/backups/restore';
  assert.equal((await request(null, exportRoute)).response.status, 401);
  assert.equal((await request(b, exportRoute)).response.status, 404);
  assert.equal((await request(a, exportRoute, 'GET', undefined, { 'X-Studio-User': b.user.id })).response.status, 403);
  const downloaded = await request(a, exportRoute);
  assert.equal(downloaded.response.status, 200);
  assert.match(downloaded.response.headers.get('content-disposition'), /attachment;.*studio-backup/);
  assert.equal(downloaded.response.headers.get('cache-control'), 'no-store');
  assert.equal(Number(downloaded.response.headers.get('content-length')), downloaded.payload.length);
  assert.equal((await request(a, exportRoute, 'POST')).response.status, 405);
  assert.equal((await request(null, restoreRoute, 'GET')).response.status, 405);
  assert.equal((await request(null, restoreRoute, 'POST', downloaded.payload)).response.status, 401);
  assert.equal((await request(b, restoreRoute, 'POST', downloaded.payload, { 'X-Studio-User': '' })).response.status, 400);
  assert.equal((await request(b, restoreRoute, 'POST', downloaded.payload, { 'X-Studio-User': a.user.id })).response.status, 403);
  assert.equal((await request(b, restoreRoute, 'POST', downloaded.payload, { Origin: 'https://example.invalid' })).response.status, 403);
  assert.ok([400, 415].includes((await request(b, restoreRoute, 'POST', downloaded.payload, { 'Content-Type': 'text/plain' })).response.status));
  assert.equal((await request(b, restoreRoute, 'POST', Buffer.from('invalid backup'))).response.status, 400);
  const restored = await request(b, restoreRoute, 'POST', downloaded.payload);
  assert.equal(restored.response.status, 201, JSON.stringify(restored.payload));
  assert.equal(restored.payload.revision, 4);
  assert.equal(restored.payload.publication, null);
  assert.notEqual(restored.payload.id, 'source');
  assert.equal(store.get(restored.payload.id, a.user.id), null);
  assert.equal(store.get(restored.payload.id, b.user.id).versions.length, 4);

  store.save('source', { ...metadata('多分块备份', 4), description: '多分块文本'.repeat(30000) }, null, a.user.id);
  const larger = await request(a, exportRoute);
  assert.ok(larger.payload.length > 65536);
  const largeRestore = await request(b, restoreRoute, 'POST', larger.payload);
  assert.equal(largeRestore.response.status, 201);
  assert.equal(largeRestore.payload.revision, 5);
  assert.equal(largeRestore.payload.description, '多分块文本'.repeat(30000));

  const oversized = await new Promise((resolve, reject) => {
    const req = http.request(base + restoreRoute, { method: 'POST', headers: { ...headers(b), 'Content-Type': 'application/octet-stream', 'Content-Length': 512 * 1024 * 1024 + 1 } }, response => {
      response.resume(); response.once('end', () => resolve(response.statusCode));
    });
    req.once('error', reject); req.end();
  });
  assert.equal(oversized, 413);
  await new Promise(resolve => {
    const req = http.request(base + restoreRoute, { method: 'POST', headers: { ...headers(b), 'Content-Type': 'application/octet-stream', 'Content-Length': 100000 } });
    req.on('error', () => {}); req.write('partial'); setTimeout(() => { req.destroy(); resolve(); }, 30);
  });
  for (let attempt = 0; attempt < 30; attempt++) {
    if (!(await fs.readdir(directory)).some(name => name.startsWith('.backup-'))) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.deepEqual((await fs.readdir(directory)).filter(name => name.startsWith('.backup-')), []);
  assert.equal((await request(null, '/api/health')).response.status, 200);
  for (const route of ['/backup.cjs', '/data/archive.studio-backup']) assert.equal((await request(null, route)).response.status, 404);
});

test('archive metadata footprint is bounded before restoring a large history', { timeout: 60000 }, async t => {
  const { directory, store, a, b } = await fixture(t);
  const archive = path.join(directory, 'large-history.studio-backup');
  store.exportBackup('source', archive, a.user.id);
  const db = new DatabaseSync(archive);
  try {
    db.exec('DELETE FROM versions; UPDATE backup_info SET currentVersion=20; BEGIN');
    const insert = db.prepare('INSERT INTO versions VALUES (?,?,?,?,?,?,?,?)');
    const description = 'x'.repeat(1024 * 1024);
    for (let version = 1; version <= 20; version++) insert.run(version, '2026-01-01T00:00:00.000Z', '大版本历史', description, 'notes', null, null, null);
    db.exec('COMMIT');
  } finally { db.close(); }
  const before = store.list(b.user.id);
  assert.throws(() => store.restoreBackup(archive, b.user.id), rejectsStatus(413));
  assert.deepEqual(store.list(b.user.id), before);
});

// ---- P15: SQLite LENGTH(TEXT) truncates at U+0000; metadata size limits must survive it ----

test('SQL length and NUL probes pin SQLite text semantics around U+0000', () => {
  const probe = new DatabaseSync(':memory:');
  probe.exec('CREATE TABLE p (x TEXT) STRICT');
  probe.prepare('INSERT INTO p VALUES (?)').run('ab\u0000中文\u0000tail');
  const row = probe.prepare(
    "SELECT LENGTH(x) AS l, INSTR(CAST(x AS BLOB), X'00') AS nulPos, " +
    "INSTR(x, CHAR(0)) AS charNul, " +
    "INSTR(CAST('无空字符' AS BLOB), X'00') AS cleanPos, INSTR('无空字符', CHAR(0)) AS cleanChar, " +
    "LENGTH(CAST('中文' AS BLOB)) AS bytes FROM p"
  ).get();
  assert.equal(row.l, 2, 'LENGTH(TEXT) must stop at the first U+0000');
  assert.equal(row.nulPos, 3, 'INSTR over BLOB cast returns 1-based byte position of the first NUL');
  assert.equal(row.charNul, 3, 'INSTR(x, CHAR(0)) finds the U+0000 character');
  assert.equal(row.cleanChar, 0, 'U+0000-free text must not be flagged');
  assert.equal(row.cleanPos, 0, 'NUL-free text must not be flagged');
  assert.equal(row.bytes, 6, '中文 stays 6 UTF-8 bytes while LENGTH counts code points');
  probe.close();
  // Same character probe must behave identically on UTF-16 encoded databases, whose clean
  // ASCII text legitimately contains 0x00 bytes in a byte-level scan.
  for (const enc of ['UTF-16le', 'UTF-16be']) {
    const probe16 = new DatabaseSync(':memory:');
    probe16.exec(`PRAGMA encoding='${enc}'; CREATE TABLE p (x TEXT) STRICT`);
    probe16.prepare('INSERT INTO p VALUES (?)').run('ab\u0000tail');
    const r16 = probe16.prepare("SELECT INSTR(x, CHAR(0)) AS p, INSTR('utf16-clean', CHAR(0)) AS clean FROM p").get();
    assert.equal(r16.p, 3, `${enc}: CHAR(0) probe finds the NUL character`);
    assert.equal(r16.clean, 0, `${enc}: clean ASCII text is not flagged`);
    probe16.close();
  }
});

test('U+0000 metadata is rejected on export and restore before copying data', { timeout: 60000 }, async t => {
  const { directory, dbPath, store, a, b } = await fixture(t);
  const archive = path.join(directory, 'nul.studio-backup');
  store.exportBackup('source', archive, a.user.id); // pristine copy, must never be overwritten
  const pristine = await fs.readFile(archive);

  // Export direction: plant a NUL-padded title directly in the source database.
  const plant = new DatabaseSync(dbPath);
  try { plant.prepare('UPDATE versions SET title = ? WHERE draftId = ?').run(NUL_TITLE, 'source'); }
  finally { plant.close(); }
  assert.throws(() => store.exportBackup('source', archive, a.user.id), rejectsStatus(400), 'NUL title must be rejected pre-copy');
  assert.deepEqual(await fs.readFile(archive), pristine, 'existing backup must not be touched by a failed export');

  // Restore direction: export a clean draft first, then tamper with the archive copy (title only).
  const cleanPath = path.join(directory, 'clean-title.studio-backup');
  const cleaner = new DatabaseSync(dbPath);
  try { cleaner.prepare("UPDATE versions SET title = 'clean-title' WHERE draftId = ?").run('source'); }
  finally { cleaner.close(); }
  store.exportBackup('source', cleanPath, a.user.id);
  const tamper = new DatabaseSync(cleanPath);
  try { tamper.prepare('UPDATE versions SET title = ? WHERE version = 1').run(NUL_TITLE); }
  finally { tamper.close(); }
  const before = store.list(b.user.id);
  assert.throws(() => store.restoreBackup(cleanPath, b.user.id), rejectsStatus(400), 'NUL metadata must be rejected pre-copy');
  assert.deepEqual(store.list(b.user.id), before, 'invalid backup must not modify target account data');
});

// ---- P15-C: per-field NUL/oversize regression on the real store export/restore paths ----

test('planted U+0000 in any single field is rejected on export without creating files', { timeout: 60000 }, async t => {
  const { directory, dbPath, store, a } = await fixture(t);
  const kept = path.join(directory, 'kept.studio-backup');
  store.exportBackup('source', kept, a.user.id); // pre-existing legal target, must never change
  const keptBytes = await fs.readFile(kept);
  const fresh = path.join(directory, 'fresh.studio-backup');
  const noSuch = () => assert.rejects(fs.stat(fresh), { code: 'ENOENT' }, 'failed export must not create a target file');

  const live = new DatabaseSync(dbPath);
  try {
    const row1 = live.prepare("SELECT savedAt, title, description, category, fileName, fileType FROM versions WHERE draftId='source' AND version=1").get();
    const originalCreated = live.prepare("SELECT createdAt FROM drafts WHERE id='source'").get().createdAt;
    const resetRow = () => live.prepare(
      "UPDATE versions SET savedAt=?, title=?, description=?, category=?, fileName=?, fileType=? WHERE draftId='source' AND version=1"
    ).run(row1.savedAt, row1.title, row1.description, row1.category, row1.fileName, row1.fileType);
    const setRow = (field, value) => live.prepare(`UPDATE versions SET ${field}=? WHERE draftId='source' AND version=1`).run(value);

    // One field polluted per case; hidden tails exceed the real field caps so a surviving
    // LENGTH-only limit check would be demonstrably bypassed.
    const nulCases = [
      ['title (start)', 'title', '\u0000' + '大'.repeat(MAX_TITLE_LEN_SAFE)],
      ['title (middle)', 'title', 'ab\u0000' + '大'.repeat(MAX_TITLE_LEN_SAFE)],
      ['title (end of visible text)', 'title', 'x'.repeat(MAX_TITLE_CHARS) + '\u0000' + 'y'.repeat(MAX_TITLE_LEN_SAFE)],
      ['description', 'description', '\u0000' + 'x'.repeat(MAX_DESCRIPTION_LEN_SAFE + 1)],
      ['savedAt', 'savedAt', ISO_TS + '\u0000' + 'x'.repeat(MAX_TITLE_LEN_SAFE)],
      ['category', 'category', 'notes\u0000' + 'x'.repeat(MAX_TITLE_LEN_SAFE)],
      ['fileName', 'fileName', '清.txt\u0000' + 'x'.repeat(MAX_FILE_NAME_CHARS + 1)],
      ['fileType', 'fileType', 'text/plain\u0000' + 'x'.repeat(MAX_FILE_TYPE_CHARS + 1)],
    ];
    for (const [label, field, value] of nulCases) {
      setRow(field, value);
      assert.throws(() => store.exportBackup('source', fresh, a.user.id), rejectsStatus(400), label);
      // NUL is checked before target-existence, so an existing target also fails 400, byte-identical.
      assert.throws(() => store.exportBackup('source', kept, a.user.id), rejectsStatus(400), label);
      await noSuch();
      assert.deepEqual(await fs.readFile(kept), keptBytes, label);
      resetRow();
    }

    // drafts.createdAt is gated by the SQL scalar check before validIsoDate ever sees JS text.
    live.prepare("UPDATE drafts SET createdAt=? WHERE id='source'").run('\u0000' + ISO_TS);
    assert.throws(() => store.exportBackup('source', fresh, a.user.id), rejectsStatus(400), 'drafts.createdAt at start');
    await noSuch();
    live.prepare("UPDATE drafts SET createdAt=? WHERE id='source'").run(ISO_TS + '\u0000hidden-tail');
    assert.throws(() => store.exportBackup('source', fresh, a.user.id), rejectsStatus(400), 'drafts.createdAt hidden tail');
    await noSuch();
    live.prepare("UPDATE drafts SET createdAt=? WHERE id='source'").run(originalCreated);

    // Same fields oversized without NUL must stay 413 (size direction unchanged).
    const bigCases = [
      ['title', '大'.repeat(MAX_TITLE_CHARS + 1)],
      ['description', '落'.repeat(MAX_DESCRIPTION_CHARS + 1)],
      ['savedAt', 'a'.repeat(32 + 1)],
      ['category', 'c'.repeat(16 + 1)],
      ['fileName', 'f'.repeat(MAX_FILE_NAME_CHARS + 1)],
      ['fileType', 't'.repeat(MAX_FILE_TYPE_CHARS + 1)],
    ];
    for (const [field, value] of bigCases) {
      setRow(field, value);
      assert.throws(() => store.exportBackup('source', fresh, a.user.id), rejectsStatus(413), field);
      await noSuch();
      resetRow();
    }

    // Legacy NULL description export is unchanged (restores normalized to '').
    live.prepare("UPDATE versions SET description=NULL WHERE draftId='source' AND version=1").run();
    const nullDesc = path.join(directory, 'null-desc.studio-backup');
    store.exportBackup('source', nullDesc, a.user.id);
    const legacy = store.restoreBackup(nullDesc, a.user.id);
    assert.equal(store.get(legacy.id, a.user.id).versions[0].description, '');
    resetRow(); // put the source row back before the final integrity check

    const rowNow = live.prepare("SELECT savedAt, title, description, category, fileName, fileType FROM versions WHERE draftId='source' AND version=1").get();
    assert.deepEqual(rowNow, row1, 'source metadata row must be byte-for-byte restored');
    assert.equal(live.prepare("SELECT createdAt FROM drafts WHERE id='source'").get().createdAt, originalCreated, 'draft createdAt restored');
  } finally { live.close(); }
});

test('planted U+0000 in any single archive field is rejected before touching target data', { timeout: 60000 }, async t => {
  const { directory, dbPath, store, a, b } = await fixture(t);
  const base = path.join(directory, 'base.studio-backup');
  store.exportBackup('source', base, a.user.id);

  const before = store.list(b.user.id);
  const counts = () => {
    const d = new DatabaseSync(dbPath);
    try {
      return d.prepare('SELECT (SELECT COUNT(*) FROM drafts) AS drafts, (SELECT COUNT(*) FROM versions) AS versions, ' +
        '(SELECT COUNT(*) FROM draft_owners) AS owners, (SELECT COUNT(*) FROM publications) AS publications').get();
    } finally { d.close(); }
  };
  const original = counts();
  const setRow = (db, field, value) => db.prepare(`UPDATE versions SET ${field} = ? WHERE version = 1`).run(value);

  const nulCases = [
    ['versions.title', db => setRow(db, 'title', '\u0000' + '大'.repeat(MAX_TITLE_LEN_SAFE))],
    ['versions.description', db => setRow(db, 'description', 'ab\u0000' + 'x'.repeat(MAX_DESCRIPTION_LEN_SAFE + 1))],
    ['versions.savedAt', db => setRow(db, 'savedAt', ISO_TS + '\u0000' + 'x'.repeat(MAX_TITLE_LEN_SAFE))],
    ['versions.category', db => setRow(db, 'category', 'notes\u0000' + 'x'.repeat(MAX_TITLE_LEN_SAFE))],
    ['versions.fileName', db => setRow(db, 'fileName', '清.txt\u0000' + 'x'.repeat(MAX_FILE_NAME_CHARS + 1))],
    ['versions.fileType', db => setRow(db, 'fileType', 'text/plain\u0000' + 'x'.repeat(MAX_FILE_TYPE_CHARS + 1))],
    ['backup_info.format', db => db.prepare('UPDATE backup_info SET format = ?').run('sidereal-draft-backup\u0000' + 'x'.repeat(MAX_TITLE_LEN_SAFE))],
    ['backup_info.createdAt', db => db.prepare('UPDATE backup_info SET createdAt = ?').run(ISO_TS + '\u0000' + 'x'.repeat(MAX_TITLE_LEN_SAFE))],
    ['sqlite_schema.sql (writable_schema NUL tail)', db => {
      db.exec('PRAGMA writable_schema = ON');
      db.prepare("UPDATE sqlite_schema SET sql = sql || ? WHERE name = 'versions'").run('\u0000' + 'x'.repeat(6000));
      db.exec('PRAGMA writable_schema = OFF');
    }],
  ];
  for (const [label, mutate] of nulCases) {
    const bad = path.join(directory, 'bad-nul-' + sanitize(label) + '.studio-backup');
    await fs.copyFile(base, bad);
    const db = new DatabaseSync(bad);
    try { mutate(db); } finally { db.close(); }
    assert.throws(() => store.restoreBackup(bad, b.user.id), rejectsStatus(400), label);
    assert.deepEqual(store.list(b.user.id), before, label);
    assert.deepEqual(counts(), original, label);
  }

  // Oversized clean values (no NUL) keep the 413 direction on restore as well.
  const bigCases = [
    ['title', db => setRow(db, 'title', '大'.repeat(MAX_TITLE_CHARS + 1))],
    ['description', db => setRow(db, 'description', '落'.repeat(MAX_DESCRIPTION_CHARS + 1))],
    ['fileName', db => setRow(db, 'fileName', 'f'.repeat(MAX_FILE_NAME_CHARS + 1))],
    ['fileType', db => setRow(db, 'fileType', 't'.repeat(MAX_FILE_TYPE_CHARS + 1))],
  ];
  for (const [field, mutate] of bigCases) {
    const bad = path.join(directory, 'bad-big-' + sanitize(field) + '.studio-backup');
    await fs.copyFile(base, bad);
    const db = new DatabaseSync(bad);
    try { mutate(db); } finally { db.close(); }
    assert.throws(() => store.restoreBackup(bad, b.user.id), rejectsStatus(413), field);
    assert.deepEqual(store.list(b.user.id), before, field);
    assert.deepEqual(counts(), original, field);
  }
});

function sanitize(label) {
  return String(label).replace(/[^A-Za-z0-9]+/g, '-').slice(0, 40);
}

test('metadata exactly at the character caps and UTF-16 backups restore losslessly', { timeout: 120000 }, async t => {
  const { directory, dbPath, store, a, b, first } = await fixture(t);
  const base = path.join(directory, 'caps-base.studio-backup');
  store.exportBackup('source', base, a.user.id);

  // Positive: row 1 planted at the exact character caps must export and restore intact.
  const live = new DatabaseSync(dbPath);
  let sourceCreatedAt;
  try {
    live.prepare("UPDATE versions SET title=?, description=?, fileName=?, fileType=? WHERE draftId='source' AND version=1")
      .run('😀'.repeat(MAX_TITLE_CHARS), '中'.repeat(MAX_DESCRIPTION_CHARS), '🚀'.repeat(MAX_FILE_NAME_CHARS - 4) + '.txt', 'text/plain');
    sourceCreatedAt = live.prepare("SELECT createdAt FROM drafts WHERE id='source'").get().createdAt;
  } finally { live.close(); }
  const capped = path.join(directory, 'caps.studio-backup');
  store.exportBackup('source', capped, a.user.id);
  const restored = store.restoreBackup(capped, b.user.id);
  const got = store.get(restored.id, b.user.id);
  assert.equal(got.versions.length, 4);
  assert.equal(got.versions[0].title, '😀'.repeat(MAX_TITLE_CHARS));
  assert.equal(got.versions[0].description, '中'.repeat(MAX_DESCRIPTION_CHARS));
  assert.equal(got.versions[0].file.name, '🚀'.repeat(MAX_FILE_NAME_CHARS - 4) + '.txt');
  assert.equal(got.versions[0].file.type, 'text/plain');
  assert.deepEqual(store.getFile(restored.id, 1, b.user.id).bytes, first, 'attachment with embedded 0x00 bytes stays intact');

  // UTF-16 archives built from the exact two-table schema and rows of a legal export.
  const reader = new DatabaseSync(base, { readOnly: true });
  let schema, infoRows, versionRows;
  try {
    schema = reader.prepare("SELECT name, sql FROM sqlite_schema WHERE type='table' ORDER BY rowid").all();
    infoRows = reader.prepare('SELECT format, formatVersion, createdAt, currentVersion FROM backup_info').all();
    versionRows = reader.prepare('SELECT version, savedAt, title, description, category, fileName, fileType, fileData FROM versions ORDER BY version').all();
  } finally { reader.close(); }
  assert.deepEqual(schema.map(row => row.name), ['backup_info', 'versions']);
  for (const enc of ['UTF-16le', 'UTF-16be']) {
    const target = path.join(directory, 'utf16-' + enc + '.studio-backup');
    const dest = new DatabaseSync(target);
    try {
      dest.exec(`PRAGMA encoding='${enc}'`);
      for (const table of schema) dest.exec(table.sql);
      dest.exec('BEGIN');
      dest.prepare('INSERT INTO backup_info VALUES (?, ?, ?, ?)')
        .run(infoRows[0].format, infoRows[0].formatVersion, infoRows[0].createdAt, infoRows[0].currentVersion);
      const insV = dest.prepare('INSERT INTO versions VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      for (const row of versionRows) {
        insV.run(row.version, row.savedAt, row.title, row.description, row.category, row.fileName, row.fileType, row.fileData);
      }
      dest.exec('COMMIT');
    } finally { dest.close(); }
    const encodingProbe = new DatabaseSync(target, { readOnly: true });
    let actual;
    try { actual = encodingProbe.prepare('PRAGMA encoding').get().encoding; } finally { encodingProbe.close(); }
    assert.equal(actual, enc, `archive must really be ${enc}`);
    const utf16 = store.restoreBackup(target, b.user.id);
    const copy = store.get(utf16.id, b.user.id);
    assert.equal(copy.versions.length, 4, `${enc}: all versions imported`);
    assert.equal(copy.versions[0].title, '第一版', `${enc}: Chinese metadata preserved`);
    assert.equal(copy.versions[0].description, '备份简介 <img src=x>', `${enc}: description preserved`);
    assert.equal(copy.createdAt, sourceCreatedAt);
    assert.deepEqual(store.getFile(utf16.id, 1, b.user.id).bytes, first, `${enc}: NUL-bearing attachment preserved`);
  }
});
