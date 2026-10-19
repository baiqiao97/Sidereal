const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createStore } = require('../store.cjs');

const root = path.resolve(__dirname, '..');
const password = 'Synthetic-Hosted-Test-Password!';

// 使用原生 HTTP 客户端，确保实际发送测试指定的 Host，而非被 fetch 自动替换。
function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, options, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode,
        headers: { get(name) { const value = response.headers[name.toLowerCase()]; return Array.isArray(value) ? value[0] : value ?? null; } },
        json: async () => JSON.parse(Buffer.concat(chunks).toString('utf8'))
      }));
    });
    req.on('error', reject); req.end(options.body);
  });
}

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sidereal-hosted-test-'));
  const children = [];
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
    }
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('sidereal-hosted-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  function start(dataDir, origin) {
    const env = { ...process.env }; delete env.STUDIO_PUBLIC_ORIGIN;
    if (origin !== undefined) env.STUDIO_PUBLIC_ORIGIN = origin;
    const child = spawn(process.execPath, [path.join(root, 'server.cjs'), root, String(port), dataDir], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', bytes => { out += bytes; }); child.stderr.on('data', bytes => { err += bytes; });
    children.push(child);
    return { child, stdout: () => out, stderr: () => err };
  }
  return { directory, port, base: 'http://127.0.0.1:' + port, start };
}

test('hosted origin rejects malformed or insecure configuration before creating a database', { timeout: 60000 }, async t => {
  const { directory, start } = await fixture(t);
  const invalid = ['', 'http://studio.example.test', 'https://studio.example.test/',
    'https://studio.example.test/path', 'https://studio.example.test?query=1', 'https://studio.example.test#fragment',
    'https://user:private-synthetic-value@studio.example.test', 'https://STUDIO.example.test', 'https://studio.example.test:443', 'not-a-url'];
  for (let i = 0; i < invalid.length; i++) {
    const data = path.join(directory, 'invalid-' + i);
    const run = start(data, invalid[i]);
    const code = await new Promise((resolve, reject) => { run.child.once('error', reject); run.child.once('exit', resolve); });
    assert.equal(code, 1, invalid[i]);
    assert.match(run.stderr(), /STUDIO_PUBLIC_ORIGIN/);
    assert.equal(run.stderr().includes('private-synthetic-value'), false);
    await assert.rejects(fs.stat(data), { code: 'ENOENT' });
  }
});

test('an uninitialized database cannot be exposed through the hosted configuration', { timeout: 60000 }, async t => {
  const { directory, start } = await fixture(t);
  const run = start(path.join(directory, 'empty'), 'https://studio.example.test');
  const code = await new Promise((resolve, reject) => { run.child.once('error', reject); run.child.once('exit', resolve); });
  assert.equal(code, 1); assert.match(run.stderr(), /首个账户/);
  assert.equal(run.stdout().includes('Content Studio:'), false);
  const store = createStore(path.join(directory, 'empty', 'drafts.db'));
  try { assert.equal(store.auth.status().needsSetup, true); } finally { store.close(); }
});

test('hosted requests require the configured host and HTTPS origin and issue secure cookies', { timeout: 60000 }, async t => {
  const { directory, base, start } = await fixture(t);
  const dataDir = path.join(directory, 'initialized');
  await fs.mkdir(dataDir);
  const store = createStore(path.join(dataDir, 'drafts.db'));
  const user = await store.auth.setup('hosted_owner', password, true);
  store.save('private_source', { title: '资料保留', description: '', category: 'notes', expectedVersion: 0 }, null, user.user.id);
  store.close();
  const origin = 'https://studio.example.test:8443';
  const run = start(dataDir, origin);
  await new Promise((resolve, reject) => { run.child.once('error', reject); run.child.once('exit', code => reject(new Error('server exit ' + code + ': ' + run.stderr()))); run.child.stdout.once('data', resolve); });
  const host = 'studio.example.test:8443';
  async function get(url, extra = {}) { return request(base + url, { headers: { Host: host, ...extra } }); }
  assert.equal((await get('/api/health')).status, 200);
  assert.equal((await request(base + '/api/health')).status, 403);
  assert.equal((await get('/api/health', { Host: 'evil.example.test', 'X-Forwarded-Host': host })).status, 403);
  assert.equal((await get('/api/health', { Origin: base, 'X-Forwarded-Proto': 'https' })).status, 403);
  assert.equal((await get('/api/health', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await get('/api/health', { Origin: origin, 'X-Forwarded-Host': 'evil.example.test', 'X-Forwarded-Proto': 'http' })).status, 200);
  const page = await get('/');
  assert.equal(page.status, 200);
  for (const response of [page, await get('/not-a-route'), await get('/api/drafts')]) {
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  }
  for (const name of ['/server.cjs', '/auth.cjs', '/data/drafts.db', '/.env']) assert.equal((await get(name)).status, 404);
  const login = await request(base + '/api/auth/login', { method: 'POST', headers: { Host: host, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user.user.username, password }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie');
  assert.match(cookie, /; Secure(?:;|$)/); assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/); assert.doesNotMatch(cookie, /Domain=/);
  const privateList = await get('/api/drafts', { Cookie: cookie.split(';')[0], 'X-Studio-User': user.user.id });
  assert.equal(privateList.status, 200); assert.equal((await privateList.json())[0].title, '资料保留');
  const logout = await request(base + '/api/auth/logout', { method: 'POST', headers: { Host: host, Origin: origin, Cookie: cookie.split(';')[0] } });
  assert.equal(logout.status, 204); assert.match(logout.headers.get('set-cookie'), /; Secure(?:;|$)/);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.ok(run.stdout().includes(origin));
});
