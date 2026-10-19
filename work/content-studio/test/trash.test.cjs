const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { createStore } = require('../store.cjs');
const root = path.resolve(__dirname, '..');
const metadata = (title, expectedVersion = 0) => ({ title, expectedVersion, description: '', category: 'notes' });
const status = expected => error => error.status === expected;

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sidereal-trash-test-'));
  const dbPath = path.join(directory, 'drafts.db');
  const store = createStore(dbPath);
  const state = { store, directory, dbPath };
  t.after(async () => {
    if (state.child && state.child.exitCode === null && state.child.signalCode === null) await new Promise(resolve => { state.child.once('exit', resolve); state.child.kill(); });
    store.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('sidereal-trash-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const a = await store.auth.setup('trash_owner', 'Synthetic-Trash-Password!', true);
  const b = await store.auth.register('other_owner', 'Synthetic-Other-Password!');
  return Object.assign(state, { a, b });
}

test('trash withdraws public data, blocks active routes, preserves history and restores privately', async t => {
  const { store, directory, dbPath, a, b } = await fixture(t);
  const bytes = Buffer.from('synthetic historical attachment');
  store.save('source', metadata('<img src=x onerror=alert(1)>'), { name: 'file.txt', type: 'text/plain', bytes }, a.user.id);
  store.publish('source', 1, a.user.id);
  const copy = store.importPublication('source', 1, b.user.id);
  const before = store.save('source', metadata('private second version', 1), null, a.user.id);
  assert.throws(() => store.remove('source', 1, a.user.id), status(409));
  assert.equal(store.listTrash(a.user.id).length, 0);
  assert.ok(store.getPublication('source'));
  store.remove('source', 2, a.user.id);
  assert.deepEqual(store.list(a.user.id), []);
  assert.deepEqual(store.listPublications('trash_owner'), []);
  assert.equal(store.getPublication('source'), null);
  assert.equal(store.getPublishedFile('source'), null);
  assert.equal(store.get('source', a.user.id), null);
  assert.equal(store.getFile('source', 1, a.user.id), null);
  for (const action of [
    () => store.save('source', metadata('stale writer', 2), null, a.user.id),
    () => store.save('source', metadata('id reuse'), null, a.user.id),
    () => store.publish('source', 2, a.user.id),
    () => store.exportBackup('source', path.join(directory, 'denied.studio-backup'), a.user.id)
  ]) assert.throws(action, status(404));
  const [item] = store.listTrash(a.user.id);
  assert.deepEqual(Object.keys(item).sort(), ['id', 'title', 'category', 'revision', 'deletedAt', 'trashToken'].sort());
  assert.equal(item.title, before.title); assert.equal(item.revision, 2);
  assert.ok(Number.isFinite(Date.parse(item.deletedAt))); assert.ok(item.trashToken);
  assert.deepEqual(store.listTrash(b.user.id), []);
  for (const userId of [b.user.id, undefined]) {
    assert.throws(() => store.restoreTrash('source', item.trashToken, userId), status(404));
    assert.throws(() => store.purgeTrash('source', item.trashToken, userId), status(404));
  }
  // A fresh connection sees persisted trash, without replaying a UI action.
  const reopened = createStore(dbPath);
  try { assert.deepEqual(reopened.listTrash(a.user.id), [item]); } finally { reopened.close(); }
  const restored = store.restoreTrash('source', item.trashToken, a.user.id);
  assert.deepEqual(restored, { ...before, publication: null });
  assert.deepEqual(store.getFile('source', 1, a.user.id).bytes, bytes);
  assert.equal(store.getFile('source', 2, a.user.id), null);
  assert.deepEqual(store.getFile(copy.id, 1, b.user.id).bytes, bytes);
  assert.equal(store.getPublication('source'), null);
  assert.deepEqual(store.listTrash(a.user.id), []);
  assert.equal(store.save('source', metadata('third version', 2), null, a.user.id).revision, 3);
});

test('trash tokens reject stale purge after restoration and permanent removal cascades only that draft', async t => {
  const { store, dbPath, a } = await fixture(t);
  store.save('source', metadata('source'), null, a.user.id);
  store.save('unrelated', metadata('keep'), null, a.user.id);
  store.remove('source', 1, a.user.id);
  const old = store.listTrash(a.user.id)[0];
  for (const token of [null, '', {}, 'x'.repeat(101)]) {
    assert.throws(() => store.restoreTrash('source', token, a.user.id), status(400));
    assert.throws(() => store.purgeTrash('source', token, a.user.id), status(400));
  }
  assert.throws(() => store.restoreTrash('source', 'wrong', a.user.id), status(409));
  store.restoreTrash('source', old.trashToken, a.user.id);
  assert.throws(() => store.purgeTrash('source', old.trashToken, a.user.id), status(404));
  store.remove('source', 1, a.user.id);
  const fresh = store.listTrash(a.user.id)[0];
  assert.notEqual(fresh.trashToken, old.trashToken);
  assert.throws(() => store.purgeTrash('source', old.trashToken, a.user.id), status(409));
  assert.throws(() => store.restoreTrash('source', old.trashToken, a.user.id), status(409));
  store.purgeTrash('source', fresh.trashToken, a.user.id);
  assert.deepEqual(store.listTrash(a.user.id), []);
  const inspect = new DatabaseSync(dbPath);
  try {
    for (const table of ['versions', 'draft_owners', 'publications', 'draft_trash']) {
      assert.equal(inspect.prepare('SELECT COUNT(*) AS n FROM ' + table + ' WHERE draftId=?').get('source').n, 0);
    }
  } finally { inspect.close(); }
  assert.equal(store.get('unrelated', a.user.id).title, 'keep');
});

test('trash transitions roll back publication and marker changes together on SQLite errors', async t => {
  const { store, dbPath, a } = await fixture(t);
  store.save('source', metadata('published'), null, a.user.id); store.publish('source', 1, a.user.id);
  const inspect = new DatabaseSync(dbPath);
  try {
    inspect.exec("CREATE TRIGGER fail_withdraw BEFORE DELETE ON publications BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    assert.throws(() => store.remove('source', 1, a.user.id), /synthetic failure/);
    assert.deepEqual(store.listTrash(a.user.id), []); assert.ok(store.getPublication('source')); assert.ok(store.get('source', a.user.id));
    inspect.exec('DROP TRIGGER fail_withdraw'); store.remove('source', 1, a.user.id);
    const [item] = store.listTrash(a.user.id);
    inspect.exec("CREATE TRIGGER fail_restore BEFORE DELETE ON draft_trash BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    assert.throws(() => store.restoreTrash('source', item.trashToken, a.user.id), /synthetic failure/);
    assert.deepEqual(store.listTrash(a.user.id), [item]); assert.equal(store.get('source', a.user.id), null);
    inspect.exec('DROP TRIGGER fail_restore'); store.restoreTrash('source', item.trashToken, a.user.id);
    assert.equal(store.get('source', a.user.id).publication, null);
  } finally { inspect.close(); }
});

test('trash HTTP endpoints require session, identity, origin and current token', { timeout: 60000 }, async t => {
  const state = await fixture(t);
  const { store, directory, a, b } = state;
  store.save('source', metadata('source'), { name: 'file', type: 'text/plain', bytes: Buffer.from('data') }, a.user.id);
  store.publish('source', 1, a.user.id);
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const base = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, [path.join(root, 'server.cjs'), root, String(port), directory], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  state.child = child;
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => reject(new Error('server exit ' + code))); child.stdout.once('data', resolve); });
  const request = (route, method = 'GET', body, user = a, extra = {}) => fetch(base + route, {
    method, headers: { Cookie: user ? 'sidereal_session=' + user.token : '', ...(method !== 'GET' && user ? { 'X-Studio-User': user.user.id } : {}), 'Content-Type': 'application/json', ...extra },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  assert.equal((await request('/api/trash', 'GET', undefined, null)).status, 401);
  assert.equal((await request('/api/drafts/source', 'DELETE', { expectedVersion: 1 })).status, 204);
  const listed = await request('/api/trash'); assert.equal(listed.status, 200); assert.equal(listed.headers.get('cache-control'), 'no-store');
  const [item] = await listed.json(); const payload = { expectedTrashToken: item.trashToken };
  for (const route of ['/api/drafts/source', '/api/drafts/source/versions/1/file', '/api/drafts/source/backup', '/api/publications/source', '/api/publications/source/file']) assert.equal((await request(route)).status, 404);
  assert.deepEqual(await (await request('/api/trash', 'GET', undefined, b)).json(), []);
  for (const [route, method] of [['/api/trash/source/restore', 'POST'], ['/api/trash/source', 'DELETE']]) {
    assert.equal((await request(route, method, payload, b)).status, 404);
    assert.equal((await request(route, method, payload, null)).status, 401);
    assert.equal((await request(route, method, payload, a, { 'X-Studio-User': '' })).status, 400);
    assert.equal((await request(route, method, payload, a, { 'X-Studio-User': b.user.id })).status, 403);
    assert.equal((await request(route, method, payload, a, { Origin: 'https://example.invalid' })).status, 403);
    assert.equal((await request(route, method, {})).status, 400);
    assert.equal((await request(route, method, { expectedTrashToken: 'stale' })).status, 409);
    assert.equal((await request(route, method, { expectedTrashToken: 'x'.repeat(10000) })).status, 413);
  }
  assert.equal((await request('/api/trash', 'POST', {})).status, 405);
  assert.equal((await request('/api/trash/source/restore', 'GET')).status, 405);
  const restored = await request('/api/trash/source/restore', 'POST', payload); assert.equal(restored.status, 200); assert.equal((await restored.json()).publication, null);
  store.remove('source', 1, a.user.id); const fresh = store.listTrash(a.user.id)[0];
  assert.equal((await request('/api/trash/source', 'DELETE', payload)).status, 409);
  assert.equal((await request('/api/trash/source', 'DELETE', { expectedTrashToken: fresh.trashToken })).status, 204);
  assert.equal(store.get('source', a.user.id), null); assert.deepEqual(store.listTrash(a.user.id), []);
});

test('trash adapter encodes ids, sends identity and ignores expired responses from previous sessions', async () => {
  const pending = [], events = [];
  const api = vm.runInNewContext(await fs.readFile(path.join(root, 'server-api.js'), 'utf8') + '\nserverApi;', {
    Headers, Event, window: { dispatchEvent: event => events.push(event.type) },
    fetch: (url, options) => new Promise(resolve => pending.push({ url, options, resolve }))
  });
  api.setUser({ id: 'owner' });
  const old = api.listTrash(); api.setUser({ id: 'owner' });
  pending[0].resolve({ status: 401, ok: false, json: async () => ({ error: 'expired' }) });
  await assert.rejects(old, status(401)); assert.deepEqual(events, []);
  const restore = api.restoreTrash('a/b', 'token');
  assert.equal(pending[1].url, '/api/trash/a%2Fb/restore');
  assert.equal(new Headers(pending[1].options.headers).get('X-Studio-User'), 'owner');
  assert.deepEqual(JSON.parse(pending[1].options.body), { expectedTrashToken: 'token' });
  pending[1].resolve({ status: 409, ok: false, json: async () => ({ error: 'Refresh trash first' }) });
  await assert.rejects(restore, error => error.status === 409 && error.message === 'Refresh trash first');
  const purge = api.purgeTrash('source', 'token');
  pending[2].resolve({ status: 403, ok: false, json: async () => ({ error: 'changed account' }) });
  await assert.rejects(purge, status(403)); assert.equal(events.length, 1);
});
