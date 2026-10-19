const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const { createStore } = require('../store.cjs');

const root = path.resolve(__dirname, '..');
const oldPassword = 'Only-Synthetic-Old-Password!';
const newPassword = '  Only-Synthetic-New-Password!  ';
const statusIs = status => error => error.status === status;

test('late revoked-session failures do not log out a fresh session of the same account', async () => {
  const events = [];
  let finish;
  const api = vm.runInNewContext(await fs.readFile(path.join(root, 'server-api.js'), 'utf8') + '\nserverApi;', {
    Headers, Event,
    window: { dispatchEvent: event => events.push(event.type) },
    fetch: () => new Promise(resolve => { finish = resolve; })
  });
  const unauthorized = { status: 401, ok: false, json: async () => ({ error: 'Expired synthetic session' }) };
  api.setUser({ id: 'same_user' });
  const old = api.list();
  api.setUser(null);
  api.setUser({ id: 'same_user' });
  finish(unauthorized);
  await assert.rejects(old, statusIs(401));
  assert.deepEqual(events, [], 'the old request belongs to the session before password-change re-login');
  const current = api.list(); finish(unauthorized);
  await assert.rejects(current, statusIs(401));
  assert.deepEqual(events, ['studio-auth-required']);
});

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sidereal-password-test-'));
  const dbPath = path.join(directory, 'drafts.db');
  const store = createStore(dbPath);
  const lifecycle = { stop: null };
  t.after(async () => {
    if (lifecycle.stop) await lifecycle.stop();
    store.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('sidereal-password-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const a = await store.auth.setup('password_owner_a', oldPassword, true);
  const otherA = await store.auth.login('password_owner_a', oldPassword);
  const b = await store.auth.register('password_owner_b', oldPassword);
  store.save('private_a', { title: '账号资料保留', description: '', category: 'notes', expectedVersion: 0 }, null, a.user.id);
  return { directory, dbPath, store, a, otherA, b, lifecycle };
}

test('an expired private operation leaves login usable after its global lock releases', async () => {
  const nodes = {};
  const listeners = {};
  let globalBusy = false;
  const window = { addEventListener: (name, handler) => { listeners[name] = handler; } };
  vm.runInNewContext(await fs.readFile(path.join(root, 'account-ui.js'), 'utf8'), {
    window,
    document: { getElementById: id => nodes[id] ||= { value: '', addEventListener() {} } },
    serverApi: { authMe: async () => ({ user: { id: 'synthetic', username: 'synthetic' } }), setUser() {} }
  });
  const ui = window.createAccountUi({
    isBusy: () => globalBusy, setBusy: value => { globalBusy = value; },
    onAuthenticated: async () => {}, onRequired() {}, clearEditor() {}, hasEditorContent: () => false
  });
  await ui.initialize();
  globalBusy = true;
  nodes.currentPassword.value = oldPassword;
  listeners['studio-auth-required']();
  globalBusy = false;
  assert.equal(ui.canWrite(), false);
  assert.equal(nodes.authForm.hidden, false);
  assert.equal(nodes.authSubmit.disabled, false, 'private-operation completion does not render account controls again');
  assert.equal(nodes.currentPassword.value, '');
});

test('a login verified against the old password cannot create a session after password rotation', { timeout: 60000 }, async t => {
  const { dbPath, store, a } = await fixture(t);
  const crypto = require('node:crypto');
  const db = new DatabaseSync(dbPath);
  let finishHash;
  let hashReady;
  const ready = new Promise(resolve => { hashReady = resolve; });
  const exported = { exports: {} };
  vm.runInNewContext(await fs.readFile(path.join(root, 'auth.cjs'), 'utf8'), {
    module: exported, Buffer,
    require: name => name === 'node:crypto' ? { ...crypto, scrypt(...args) {
      const callback = args.pop();
      crypto.scrypt(...args, (error, value) => {
        finishHash = () => callback(error, value);
        hashReady();
      });
    } } : require(name)
  });
  const auth = exported.exports.createAuth(db);
  const pendingLogin = auth.login(a.user.username, oldPassword);
  try {
    await ready;
    await store.auth.changePassword(a.token, oldPassword, newPassword);
    finishHash();
    await assert.rejects(pendingLogin, statusIs(401));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE userId=?').get(a.user.id).n, 0);
  } finally { db.close(); }
});

test('password change rotates salted hashes and revokes only that account sessions', { timeout: 60000 }, async t => {
  const { dbPath, store, a, otherA, b } = await fixture(t);
  const db = new DatabaseSync(dbPath);
  try {
    const original = db.prepare('SELECT salt,passwordHash FROM users WHERE id=?').get(a.user.id);
    await assert.rejects(store.auth.changePassword(a.token, 'Wrong-Current-Password!', newPassword), statusIs(400));
    await assert.rejects(store.auth.changePassword(a.token, oldPassword, 'short'), statusIs(400));
    assert.ok(store.auth.current(a.token)); assert.ok(store.auth.current(otherA.token));
    assert.deepEqual(db.prepare('SELECT salt,passwordHash FROM users WHERE id=?').get(a.user.id), original);
    assert.deepEqual(await store.auth.changePassword(a.token, oldPassword, newPassword), { changed: true });
    const updated = db.prepare('SELECT salt,passwordHash FROM users WHERE id=?').get(a.user.id);
    assert.notEqual(updated.salt, original.salt); assert.notEqual(updated.passwordHash, original.passwordHash);
    assert.match(updated.salt, /^[0-9a-f]{32}$/); assert.match(updated.passwordHash, /^[0-9a-f]{128}$/);
    assert.equal(store.auth.current(a.token), null); assert.equal(store.auth.current(otherA.token), null);
    assert.equal(store.auth.current(b.token).id, b.user.id);
    assert.equal(store.get('private_a', a.user.id).title, '账号资料保留');
    await assert.rejects(store.auth.login(a.user.username, oldPassword), statusIs(401));
    await assert.rejects(store.auth.login(a.user.username, newPassword.trim()), statusIs(401));
    assert.equal((await store.auth.login(a.user.username, newPassword)).user.id, a.user.id);
  } finally { db.close(); }
});

test('password updates roll back on failure and cannot outlive their original session', { timeout: 60000 }, async t => {
  const { dbPath, store, a, otherA } = await fixture(t);
  const db = new DatabaseSync(dbPath);
  try {
    const original = db.prepare('SELECT salt,passwordHash FROM users WHERE id=?').get(a.user.id);
    db.exec("CREATE TRIGGER fail_session_revocation BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    await assert.rejects(store.auth.changePassword(a.token, oldPassword, newPassword));
    assert.deepEqual(db.prepare('SELECT salt,passwordHash FROM users WHERE id=?').get(a.user.id), original);
    assert.ok(store.auth.current(a.token)); assert.ok(store.auth.current(otherA.token));
    db.exec('DROP TRIGGER fail_session_revocation');
    const pending = store.auth.changePassword(a.token, oldPassword, newPassword);
    store.auth.logout(a.token);
    await assert.rejects(pending, statusIs(401));
    assert.deepEqual(db.prepare('SELECT salt,passwordHash FROM users WHERE id=?').get(a.user.id), original);
    assert.ok(store.auth.current(otherA.token));
  } finally { db.close(); }
});

test('simultaneous password changes cannot overwrite the winner with stale credentials', { timeout: 60000 }, async t => {
  const { store, a, otherA, b } = await fixture(t);
  const passwords = ['Synthetic-Racing-Password-One!', 'Synthetic-Racing-Password-Two!'];
  const outcomes = await Promise.allSettled([
    store.auth.changePassword(a.token, oldPassword, passwords[0]),
    store.auth.changePassword(otherA.token, oldPassword, passwords[1])
  ]);
  const winner = outcomes.findIndex(item => item.status === 'fulfilled');
  assert.ok(winner >= 0);
  assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
  const loser = outcomes[1 - winner];
  assert.ok([401, 409].includes(loser.reason.status));
  assert.equal((await store.auth.login(a.user.username, passwords[winner])).user.id, a.user.id);
  await assert.rejects(store.auth.login(a.user.username, passwords[1 - winner]), statusIs(401));
  assert.equal(store.auth.current(b.token).id, b.user.id);
});

test('password HTTP requires pinned identity and keeps sessions on validation failure', { timeout: 60000 }, async t => {
  const { directory, store, a, otherA, b, lifecycle } = await fixture(t);
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, [path.join(root, 'server.cjs'), root, String(port), directory], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  lifecycle.stop = async () => {
    if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
  };
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => reject(new Error('server exit: ' + code))); child.stdout.once('data', resolve); });
  const body = { currentPassword: oldPassword, newPassword };
  async function request(who, method = 'POST', payload = body, extra = {}) {
    const response = await fetch(base + '/api/auth/password', { method, headers: {
      ...(who ? { Cookie: 'sidereal_session=' + who.token, 'X-Studio-User': who.user.id } : {}),
      'Content-Type': 'application/json', ...extra
    }, body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(payload) });
    return { response, data: method === 'HEAD' ? null : await response.json() };
  }
  assert.equal((await request(null, 'GET')).response.status, 405);
  assert.equal((await request(null)).response.status, 401);
  assert.equal((await request(a, 'POST', body, { 'X-Studio-User': '' })).response.status, 400);
  assert.equal((await request(b, 'POST', body, { 'X-Studio-User': a.user.id })).response.status, 403);
  assert.equal((await request(a, 'POST', body, { Origin: 'https://example.invalid' })).response.status, 403);
  assert.equal((await request(a, 'POST', { ...body, currentPassword: 'Wrong-Current-Password!' })).response.status, 400);
  assert.equal((await request(a, 'POST', { ...body, newPassword: 'short' })).response.status, 400);
  assert.equal((await request(a, 'POST', { ...body, newPassword: 'x'.repeat(8193) })).response.status, 413);
  assert.ok(store.auth.current(a.token)); assert.ok(store.auth.current(otherA.token));
  const changed = await request(a);
  assert.equal(changed.response.status, 200, JSON.stringify(changed.data));
  assert.deepEqual(changed.data, { changed: true });
  assert.match(changed.response.headers.get('set-cookie'), /sidereal_session=;.*Max-Age=0/);
  assert.equal(changed.response.headers.get('cache-control'), 'no-store');
  assert.equal(store.auth.current(a.token), null); assert.equal(store.auth.current(otherA.token), null);
  assert.equal(store.auth.current(b.token).id, b.user.id);
  assert.equal(store.get('private_a', a.user.id).title, '账号资料保留');
});
