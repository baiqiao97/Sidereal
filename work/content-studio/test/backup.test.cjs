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
