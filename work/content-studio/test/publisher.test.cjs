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

test('publisher reads use anonymous identity handling and encode only the publisher path segment', async () => {
  const requests = [], events = [];
  const api = vm.runInNewContext(await fs.readFile(path.join(root, 'server-api.js'), 'utf8') + '\nserverApi;', {
    Headers, Event, window: { dispatchEvent: event => events.push(event.type) },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { status: 403, ok: false, json: async () => ({ error: 'Synthetic public failure' }) };
    }
  });
  api.setUser({ id: 'synthetic_viewer' });
  for (const publisher of [undefined, 'owner_a', 'a/b?c#d']) await assert.rejects(api.listPublications(publisher), error => error.status === 403);
  assert.deepEqual(requests.map(request => request.url), ['/api/publications', '/api/publishers/owner_a/publications', '/api/publishers/a%2Fb%3Fc%23d/publications']);
  assert.equal(requests.some(request => new Headers(request.options.headers).has('X-Studio-User')), false);
  assert.deepEqual(events, []);
});

test('publisher pages reveal only that account published snapshots and do not identify empty accounts', { timeout: 60000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sidereal-publisher-test-'));
  const store = createStore(path.join(directory, 'drafts.db'));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
    store.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('sidereal-publisher-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const password = 'Synthetic-Publisher-Test-Password!';
  const a = await store.auth.setup('owner_a', password, true);
  const b = await store.auth.register('owner_b', password);
  await store.auth.register('empty_owner', password);
  const payload = (title, expectedVersion = 0) => ({ title, description: '', category: 'notes', expectedVersion });
  store.save('a_public', payload('A公开版'), { name: '公开附件.txt', type: 'text/plain', bytes: Buffer.from('public bytes') }, a.user.id);
  store.publish('a_public', 1, a.user.id);
  store.save('a_public', payload('A未发布的新版本秘密', 1), { name: '私人附件.txt', type: 'text/plain', bytes: Buffer.from('private bytes') }, a.user.id);
  store.save('a_private', payload('A完全私有秘密'), null, a.user.id);
  store.save('b_public', payload('B公开版'), null, b.user.id); store.publish('b_public', 1, b.user.id);
  const before = store.get('a_public', a.user.id);
  const publications = store.listPublications(' OWNER_A ');
  assert.equal(publications.length, 1); assert.equal(publications[0].title, 'A公开版');
  assert.equal(publications[0].version, 1); assert.equal(publications[0].file.name, '公开附件.txt');
  assert.deepEqual(store.listPublications('empty_owner'), store.listPublications('no_such_owner'));
  assert.deepEqual(store.get('a_public', a.user.id), before);
  assert.equal(store.listPublications().length, 2);
  for (const bad of ['', null, {}, '?', 'a'.repeat(33)]) assert.throws(() => store.listPublications(bad), error => error.status === 400);
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const base = 'http://127.0.0.1:' + port;
  child = spawn(process.execPath, [path.join(root, 'server.cjs'), root, String(port), directory], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => reject(new Error('server exit ' + code))); child.stdout.once('data', resolve); });
  const endpoint = base + '/api/publishers/owner_a/publications';
  const read = await fetch(endpoint, { headers: { Cookie: 'sidereal_session=' + b.token, 'X-Studio-User': 'wrong-public-header' } });
  assert.equal(read.status, 200); assert.equal(read.headers.get('cache-control'), 'no-store');
  const publicData = await read.json(); assert.deepEqual(publicData, publications);
  const serialized = JSON.stringify(publicData);
  for (const privateValue of ['A未发布的新版本秘密', 'A完全私有秘密', '私人附件.txt', 'B公开版', password, a.token, a.user.id, 'passwordHash', 'fileData']) assert.equal(serialized.includes(privateValue), false);
  assert.deepEqual(await (await fetch(base + '/api/publishers/OWNER_A/publications')).json(), publicData);
  for (const name of ['empty_owner', 'no_such_owner']) {
    const empty = await fetch(base + '/api/publishers/' + name + '/publications');
    assert.equal(empty.status, 200); assert.deepEqual(await empty.json(), []);
  }
  for (const name of ['%3F', '%E0%A4%A', 'a'.repeat(33), '%2F']) assert.equal((await fetch(base + '/api/publishers/' + name + '/publications')).status, 400);
  for (const method of ['POST', 'DELETE', 'PUT']) {
    const response = await fetch(endpoint, { method }); assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), 'GET');
  }
  assert.equal((await fetch(endpoint, { headers: { Origin: 'https://example.invalid' } })).status, 403);
  store.unpublish('a_public', 1, a.user.id);
  assert.deepEqual(await (await fetch(endpoint)).json(), []);
  assert.equal((await (await fetch(base + '/api/publications')).json()).length, 1);
  assert.deepEqual(store.get('a_public', a.user.id), { ...before, publication: null });
});
