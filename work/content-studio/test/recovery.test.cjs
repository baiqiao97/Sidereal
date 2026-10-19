const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createStore } = require('../store.cjs');

const root = path.resolve(__dirname, '..');
const password = 'Synthetic-Recovery-Password!';
const nextPassword = '  Synthetic-New-Recovery-Password!  ';
const statusIs = status => error => error.status === status;
const digest = code => crypto.createHash('sha256').update(code).digest('hex');

test('recovery issuance pins identity while anonymous resets do not dispatch private sign-out events', async () => {
  const events = [], requests = [];
  const api = vm.runInNewContext(await fs.readFile(path.join(root, 'server-api.js'), 'utf8') + '\nserverApi;', {
    Headers, Event, window: { dispatchEvent: event => events.push(event.type) },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { status: 403, ok: false, json: async () => ({ error: 'synthetic denied' }) };
    }
  });
  api.setUser({ id: 'synthetic_owner' });
  await assert.rejects(api.authResetPassword('synthetic_owner', 'a'.repeat(64), nextPassword), statusIs(403));
  assert.deepEqual(events, []);
  assert.equal(new Headers(requests[0].options.headers).has('X-Studio-User'), false);
  await assert.rejects(api.authGenerateRecoveryCode(password), statusIs(403));
  assert.equal(new Headers(requests[1].options.headers).get('X-Studio-User'), 'synthetic_owner');
  assert.deepEqual(events, ['studio-auth-required']);
});

test('anonymous reset failures including forbidden responses remain visible and retryable', async () => {
  const nodes = {};
  let busy = false;
  const window = { addEventListener() {}, confirm: () => true };
  vm.runInNewContext(await fs.readFile(path.join(root, 'account-ui.js'), 'utf8'), {
    window,
    document: { getElementById: id => nodes[id] ||= {
      value: '', checkValidity: () => true,
      addEventListener(name, handler) { this[name] = handler; }
    } },
    serverApi: { authMe: async () => ({ user: null }), setUser() {},
      authResetPassword: async () => { throw Object.assign(new Error('Synthetic forbidden reset'), { status: 403 }); }
    }
  });
  const ui = window.createAccountUi({
    isBusy: () => busy, setBusy: value => { busy = value; },
    onRequired() {}, clearEditor() { assert.fail('reset failure must preserve the material editor'); }
  });
  await ui.initialize();
  nodes.resetUsername.value = 'synthetic'; nodes.resetCode.value = 'a'.repeat(64);
  nodes.resetNewPassword.value = nodes.resetConfirmPassword.value = nextPassword;
  await nodes.resetPasswordForm.submit({ preventDefault() {} });
  assert.match(nodes.authError.textContent, /Synthetic forbidden reset/);
  assert.equal(nodes.authError.hidden, false); assert.equal(nodes.authSubmit.disabled, false);
  assert.equal(nodes.resetCode.value, 'a'.repeat(64)); assert.equal(busy, false);
});

test('a generated code arriving after sign-out cannot reappear in the private account panel', async () => {
  const nodes = {}, listeners = {};
  let busy = false, finish;
  const window = { addEventListener: (name, handler) => { listeners[name] = handler; }, confirm: () => true };
  vm.runInNewContext(await fs.readFile(path.join(root, 'account-ui.js'), 'utf8'), {
    window,
    document: { getElementById: id => nodes[id] ||= {
      value: '', checkValidity: () => true,
      addEventListener(name, handler) { this[name] = handler; }
    } },
    serverApi: { authMe: async () => ({ user: { id: 'synthetic', username: 'synthetic' } }), setUser() {},
      authGenerateRecoveryCode: () => new Promise(resolve => { finish = resolve; })
    }
  });
  const ui = window.createAccountUi({
    isBusy: () => busy, setBusy: value => { busy = value; }, onAuthenticated: async () => {},
    onRequired() {}, clearEditor() { assert.fail('sign-out notification must preserve the material editor'); }
  });
  await ui.initialize(); nodes.recoveryCurrentPassword.value = password;
  const pending = nodes.recoveryCodeForm.submit({ preventDefault() {} });
  listeners['studio-auth-required'](); finish({ code: 'b'.repeat(64) }); await pending;
  assert.equal(nodes.generatedRecoveryCode.value, ''); assert.equal(nodes.recoveryCodeOutput.hidden, true);
  assert.equal(nodes.recoveryCurrentPassword.value, ''); assert.equal(nodes.authSubmit.disabled, false);
});

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sidereal-recovery-test-'));
  const dbPath = path.join(directory, 'drafts.db');
  const store = createStore(dbPath);
  const db = new DatabaseSync(dbPath);
  const lifecycle = { stop: null };
  t.after(async () => {
    if (lifecycle.stop) await lifecycle.stop();
    db.close(); store.close();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('sidereal-recovery-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const a = await store.auth.setup('recovery_owner_a', password, true);
  const otherA = await store.auth.login(a.user.username, password);
  const b = await store.auth.register('recovery_owner_b', password);
  store.save('private_a', { title: '恢复密码不修改资料', description: '', category: 'notes', expectedVersion: 0 }, null, a.user.id);
  store.publish('private_a', 1, a.user.id);
  return { directory, dbPath, db, store, a, otherA, b, lifecycle };
}

test('offline recovery codes are optional, hashed, replaced, and excluded from draft backups', { timeout: 60000 }, async t => {
  const { directory, db, store, a, otherA, b } = await fixture(t);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recovery_codes').get().n, 0);
  await assert.rejects(store.auth.generateRecoveryCode(null, password), statusIs(401));
  await assert.rejects(store.auth.generateRecoveryCode(a.token, 'Wrong-Synthetic-Password!'), statusIs(400));
  const originalHash = db.prepare('SELECT salt,passwordHash FROM users WHERE id=?').get(a.user.id);
  const first = await store.auth.generateRecoveryCode(a.token, password);
  assert.deepEqual(Object.keys(first), ['code']); assert.match(first.code, /^[0-9a-f]{64}$/);
  const row = db.prepare('SELECT * FROM recovery_codes WHERE userId=?').get(a.user.id);
  assert.deepEqual(Object.keys(row).sort(), ['codeHash', 'userId']);
  assert.equal(row.codeHash, digest(first.code)); assert.notEqual(row.codeHash, first.code);
  const second = await store.auth.generateRecoveryCode(a.token, password);
  assert.notEqual(first.code, second.code);
  await assert.rejects(store.auth.resetPassword(a.user.username, first.code, nextPassword), statusIs(400));
  assert.deepEqual(db.prepare('SELECT salt,passwordHash FROM users WHERE id=?').get(a.user.id), originalHash);
  assert.ok(store.auth.current(a.token)); assert.ok(store.auth.current(otherA.token)); assert.ok(store.auth.current(b.token));
  const archive = path.join(directory, 'draft.studio-backup');
  store.exportBackup('private_a', archive, a.user.id);
  const bytes = await fs.readFile(archive);
  for (const secret of [first.code, second.code, digest(second.code), 'recovery_codes']) assert.equal(bytes.includes(Buffer.from(secret)), false);
});

test('a code resets one account once, revokes its sessions, and retains owned and published data', { timeout: 60000 }, async t => {
  const { db, store, a, otherA, b } = await fixture(t);
  const { code } = await store.auth.generateRecoveryCode(a.token, password);
  const bCode = (await store.auth.generateRecoveryCode(b.token, password)).code;
  const before = store.get('private_a', a.user.id);
  const unknown = await store.auth.resetPassword('unknown_owner', code, nextPassword).catch(error => error);
  const wrong = await store.auth.resetPassword(a.user.username, 'f'.repeat(64), nextPassword).catch(error => error);
  const malformed = await store.auth.resetPassword('?', 'invalid', nextPassword).catch(error => error);
  assert.equal(unknown.status, 400); assert.equal(unknown.message, wrong.message); assert.equal(wrong.message, malformed.message);
  await assert.rejects(store.auth.resetPassword(a.user.username, code, 'short'), statusIs(400));
  assert.ok(store.auth.current(a.token));
  assert.deepEqual(await store.auth.resetPassword('  RECOVERY_OWNER_A ', ' ' + code.toUpperCase() + ' ', nextPassword), { changed: true });
  assert.equal(store.auth.current(a.token), null); assert.equal(store.auth.current(otherA.token), null);
  assert.ok(store.auth.current(b.token));
  assert.equal(db.prepare('SELECT codeHash FROM recovery_codes WHERE userId=?').get(a.user.id), undefined);
  assert.equal(db.prepare('SELECT codeHash FROM recovery_codes WHERE userId=?').get(b.user.id).codeHash, digest(bCode));
  assert.deepEqual(store.get('private_a', a.user.id), before);
  await assert.rejects(store.auth.login(a.user.username, password), statusIs(401));
  await assert.rejects(store.auth.login(a.user.username, nextPassword.trim()), statusIs(401));
  assert.equal((await store.auth.login(a.user.username, nextPassword)).user.id, a.user.id);
  await assert.rejects(store.auth.resetPassword(a.user.username, code, password), statusIs(400));
});

test('code consumption and session revocation roll back with the password, and ordinary changes invalidate codes', { timeout: 60000 }, async t => {
  const { db, store, a, otherA } = await fixture(t);
  const { code } = await store.auth.generateRecoveryCode(a.token, password);
  const before = db.prepare('SELECT salt,passwordHash FROM users WHERE id=?').get(a.user.id);
  db.exec("CREATE TRIGGER fail_recovery BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  await assert.rejects(store.auth.resetPassword(a.user.username, code, nextPassword));
  assert.deepEqual(db.prepare('SELECT salt,passwordHash FROM users WHERE id=?').get(a.user.id), before);
  assert.equal(db.prepare('SELECT codeHash FROM recovery_codes WHERE userId=?').get(a.user.id).codeHash, digest(code));
  assert.ok(store.auth.current(a.token)); assert.ok(store.auth.current(otherA.token));
  db.exec('DROP TRIGGER fail_recovery');
  await store.auth.changePassword(a.token, password, nextPassword);
  assert.equal(db.prepare('SELECT codeHash FROM recovery_codes WHERE userId=?').get(a.user.id), undefined);
  await assert.rejects(store.auth.resetPassword(a.user.username, code, password), statusIs(400));
});

test('a single recovery code cannot win two concurrent password resets', { timeout: 60000 }, async t => {
  const { store, a, b } = await fixture(t);
  const { code } = await store.auth.generateRecoveryCode(a.token, password);
  const passwords = [nextPassword, 'Another-Synthetic-Recovery-Password!'];
  const results = await Promise.allSettled(passwords.map(value => store.auth.resetPassword(a.user.username, code, value)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const winner = results.findIndex(result => result.status === 'fulfilled');
  assert.equal(results[1 - winner].reason.status, 400);
  assert.ok((await store.auth.login(a.user.username, passwords[winner])).user);
  await assert.rejects(store.auth.login(a.user.username, passwords[1 - winner]), statusIs(401));
  assert.ok(store.auth.current(b.token));
});

test('generating a recovery code cannot outlive the authenticated session used to verify its password', { timeout: 60000 }, async t => {
  const { db, store, a } = await fixture(t);
  let release, entered;
  const gate = new Promise(resolve => { entered = resolve; });
  const exported = { exports: {} };
  vm.runInNewContext(await fs.readFile(path.join(root, 'auth.cjs'), 'utf8'), {
    module: exported, Buffer,
    require: name => name === 'node:crypto' ? { ...crypto, scrypt(...args) {
      const callback = args.pop();
      crypto.scrypt(...args, (error, value) => { release = () => callback(error, value); entered(); });
    } } : require(name)
  });
  const pending = exported.exports.createAuth(db).generateRecoveryCode(a.token, password);
  await gate; store.auth.logout(a.token); release();
  await assert.rejects(pending, statusIs(401));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recovery_codes').get().n, 0);
});

test('recovery HTTP enforces issuance identity and origin, limits attempts, and never logs in after reset', { timeout: 60000 }, async t => {
  const { directory, store, a, otherA, b, lifecycle } = await fixture(t);
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const base = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, [path.join(root, 'server.cjs'), root, String(port), directory], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  lifecycle.stop = async () => { if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => { child.once('exit', resolve); child.kill(); }); };
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => reject(new Error('server exit ' + code))); child.stdout.once('data', resolve); });
  async function request(action, who, payload, extra = {}, method = 'POST') {
    const response = await fetch(base + '/api/auth/' + action, { method, headers: {
      'Content-Type': 'application/json', ...(who ? { Cookie: 'sidereal_session=' + who.token, 'X-Studio-User': who.user.id } : {}), ...extra
    }, body: method === 'GET' ? undefined : JSON.stringify(payload) });
    return { response, data: await response.json() };
  }
  const issue = { currentPassword: password };
  assert.equal((await request('recovery-code', null, issue)).response.status, 401);
  assert.equal((await request('recovery-code', a, issue, {}, 'GET')).response.status, 405);
  assert.equal((await request('reset-password', null, {}, {}, 'GET')).response.status, 405);
  assert.equal((await request('recovery-code', a, issue, { 'X-Studio-User': '' })).response.status, 400);
  assert.equal((await request('recovery-code', b, issue, { 'X-Studio-User': a.user.id })).response.status, 403);
  assert.equal((await request('recovery-code', a, issue, { Origin: 'https://example.invalid' })).response.status, 403);
  assert.equal((await request('recovery-code', a, { currentPassword: 'x'.repeat(8193) })).response.status, 413);
  const issued = await request('recovery-code', a, issue);
  assert.equal(issued.response.status, 200); assert.match(issued.data.code, /^[0-9a-f]{64}$/);
  assert.equal(issued.response.headers.get('set-cookie'), null);
  assert.equal(issued.response.headers.get('cache-control'), 'no-store');
  const reset = { username: a.user.username, code: issued.data.code, newPassword: nextPassword };
  assert.equal((await request('reset-password', null, reset, { Origin: 'https://example.invalid' })).response.status, 403);
  const failed = await request('reset-password', b, { ...reset, code: '0'.repeat(64) });
  assert.equal(failed.response.status, 400); assert.equal(failed.response.headers.get('set-cookie'), null);
  const success = await request('reset-password', null, reset);
  assert.equal(success.response.status, 200); assert.deepEqual(success.data, { changed: true });
  assert.match(success.response.headers.get('set-cookie'), /sidereal_session=;.*Max-Age=0/);
  assert.equal(store.auth.current(a.token), null); assert.equal(store.auth.current(otherA.token), null);
  assert.ok(store.auth.current(b.token));
  assert.equal((await request('reset-password', null, reset)).response.status, 400);
  let limited = false;
  for (let i = 0; i < 35; i++) {
    const attempt = await request('reset-password', null, { username: '?', code: '', newPassword: nextPassword });
    if (attempt.response.status === 429) { limited = true; break; }
    assert.equal(attempt.response.status, 400);
  }
  assert.equal(limited, true);
});
