const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { createStore } = require('../store.cjs');
const root = path.resolve(__dirname, '..');
const meta = (title, expectedVersion = 0, attachmentVersion) => ({ title, expectedVersion, attachmentVersion, category: 'notes' });
const zero = { activeDrafts: 0, trashedDrafts: 0, versions: 0, attachmentBytes: 0 };

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sidereal-usage-test-'));
  const store = createStore(path.join(directory, 'drafts.db'));
  const state = { store, directory };
  t.after(async () => {
    if (state.child && state.child.exitCode === null && state.child.signalCode === null) await new Promise(resolve => { state.child.once('exit', resolve); state.child.kill(); });
    store.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('sidereal-usage-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const a = await store.auth.setup('usage_owner', 'Synthetic-Usage-Test-Password!', true);
  const b = await store.auth.register('other_owner', 'Synthetic-Other-Test-Password!');
  return Object.assign(state, { a, b });
}

test('usage counts only owned saved data across active, trash, historical copies and permanent removal', async t => {
  const { store, directory, a, b } = await fixture(t);
  assert.deepEqual(store.getUsage(a.user.id), zero);
  store.save('other_secret', meta('not yours'), { name: 'secret', type: 'text/plain', bytes: Buffer.alloc(10000) }, b.user.id);
  assert.deepEqual(store.getUsage(a.user.id), zero);
  store.save('own_file', meta('first'), { name: 'own.txt', type: 'text/plain', bytes: Buffer.from('12345') }, a.user.id);
  store.save('own_file', meta('copy attachment', 1, 1), null, a.user.id);
  const before = store.save('own_file', meta('remove current attachment', 2), null, a.user.id);
  store.save('own_empty', meta('empty file'), { name: 'empty.txt', type: 'text/plain', bytes: Buffer.alloc(0) }, a.user.id);
  const expected = { activeDrafts: 2, trashedDrafts: 0, versions: 4, attachmentBytes: 10 };
  assert.deepEqual(store.getUsage(a.user.id), expected);
  store.publish('own_file', 3, a.user.id);
  assert.deepEqual(store.getUsage(a.user.id), expected, 'public snapshots do not add another stored version');
  assert.deepEqual(store.get('own_file', a.user.id), { ...before, publication: store.get('own_file', a.user.id).publication });
  store.remove('own_file', 3, a.user.id);
  assert.deepEqual(store.getUsage(a.user.id), { ...expected, activeDrafts: 1, trashedDrafts: 1 });
  const item = store.listTrash(a.user.id)[0]; store.restoreTrash(item.id, item.trashToken, a.user.id);
  assert.deepEqual(store.getUsage(a.user.id), expected);
  const backup = path.join(directory, 'synthetic.studio-backup'); store.exportBackup('own_file', backup, a.user.id);
  const restored = store.restoreBackup(backup, a.user.id);
  assert.deepEqual(store.getUsage(a.user.id), { activeDrafts: 3, trashedDrafts: 0, versions: 7, attachmentBytes: 20 });
  store.remove('own_file', 3, a.user.id); const fresh = store.listTrash(a.user.id)[0]; store.purgeTrash('own_file', fresh.trashToken, a.user.id);
  assert.deepEqual(store.getUsage(a.user.id), expected);
  assert.equal(store.get(restored.id, a.user.id).versions.length, 3);
  assert.deepEqual(store.getUsage(b.user.id), { activeDrafts: 1, trashedDrafts: 0, versions: 1, attachmentBytes: 10000 });
});

test('usage HTTP is private read-only metadata and cannot select another account', { timeout: 60000 }, async t => {
  const state = await fixture(t); const { store, directory, a, b } = state;
  store.save('secret_id', meta('Private title'), { name: 'private.txt', type: 'text/plain', bytes: Buffer.from('private bytes') }, a.user.id);
  const before = store.get('secret_id', a.user.id);
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); const base = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, [path.join(root, 'server.cjs'), root, String(port), directory], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); state.child = child;
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => reject(new Error('server exit ' + code))); child.stdout.once('data', resolve); });
  const read = (user, headers = {}, suffix = '') => fetch(base + '/api/account/usage' + suffix, { headers: { ...(user ? { Cookie: 'sidereal_session=' + user.token } : {}), ...headers } });
  assert.equal((await read(null)).status, 401);
  assert.equal((await read(a, { 'X-Studio-User': b.user.id })).status, 403);
  assert.equal((await read(a, { Origin: 'https://example.invalid' })).status, 403);
  const response = await read(a, { 'X-Studio-User': a.user.id }); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json(); assert.deepEqual(body, { activeDrafts: 1, trashedDrafts: 0, versions: 1, attachmentBytes: 13 });
  for (const value of Object.values(body)) assert.equal(typeof value, 'number');
  assert.deepEqual(await (await read(a, {}, '?userId=' + b.user.id)).json(), body);
  assert.deepEqual(await (await read(b)).json(), zero);
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const denied = await fetch(base + '/api/account/usage', { method, headers: { Cookie: 'sidereal_session=' + a.token, 'X-Studio-User': a.user.id } });
    assert.equal(denied.status, 405); assert.equal(denied.headers.get('allow'), 'GET');
  }
  assert.deepEqual(store.get('secret_id', a.user.id), before);
});

test('usage adapter pins identity and discards stale same-account session failures', async () => {
  const pending = [], events = [];
  const api = vm.runInNewContext(await fs.readFile(path.join(root, 'server-api.js'), 'utf8') + '\nserverApi;', {
    Headers, Event, window: { dispatchEvent: event => events.push(event.type) },
    fetch: (url, options) => new Promise(resolve => pending.push({ url, options, resolve }))
  });
  api.setUser({ id: 'owner' }); const old = api.getUsage();
  assert.equal(pending[0].url, '/api/account/usage'); assert.equal(new Headers(pending[0].options.headers).get('X-Studio-User'), 'owner');
  api.setUser({ id: 'owner' }); pending[0].resolve({ status: 401, ok: false, json: async () => ({ error: 'expired' }) });
  await assert.rejects(old, error => error.status === 401); assert.deepEqual(events, []);
  const current = api.getUsage(); pending[1].resolve({ status: 403, ok: false, json: async () => ({ error: 'changed' }) });
  await assert.rejects(current, error => error.status === 403); assert.equal(events.length, 1);
});
