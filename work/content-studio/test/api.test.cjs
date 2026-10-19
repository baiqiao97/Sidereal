const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const root = path.resolve(__dirname, '..');
const password = 'Only-Synthetic-Test-Password!';

test('Content Studio: local accounts, versions and public copies', { timeout: 60000 }, async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sidereal-studio-test-'));
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const base = 'http://127.0.0.1:' + port;
  let child;

  async function stop() {
    const running = child;
    child = null;
    if (running && running.exitCode === null && running.signalCode === null) {
      await new Promise(resolve => { running.once('exit', resolve); running.kill(); });
    }
  }
  t.after(async () => {
    await stop();
    // Only remove the unique temporary directory this test created.
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith('sidereal-studio-test-'));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  async function start(directory = dataDir) {
    child = spawn(process.execPath, [path.join(root, 'server.cjs'), root, String(port), directory], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => reject(new Error('Test server exited: ' + code)));
      child.stdout.once('data', resolve);
    });
  }
  function client() {
    return {
      cookie: '', user: null,
      async request(route, method = 'GET', body, extra = {}) {
        const response = await fetch(base + route, {
          method,
          headers: {
            ...(this.cookie ? { Cookie: this.cookie, 'X-Studio-User': this.user.id } : {}),
            ...(body === undefined || body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
            ...extra
          },
          body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body)
        });
        const cookie = response.headers.get('set-cookie');
        if (cookie) this.cookie = cookie.split(';')[0];
        const data = response.status === 204 || method === 'HEAD' ? null
          : (response.headers.get('content-type') || '').includes('json') ? await response.json()
            : Buffer.from(await response.arrayBuffer());
        if (data && data.user) this.user = data.user;
        return { status: response.status, data, cookie };
      }
    };
  }
  async function expect(who, route, method, body, status, extra) {
    const result = await who.request(route, method, body, extra);
    assert.equal(result.status, status, route + ': ' + JSON.stringify(result.data));
    return result.data;
  }
  function form(title, version, bytes, attachmentVersion) {
    const body = new FormData();
    body.append('metadata', JSON.stringify({ title, category: 'notes', description: '', expectedVersion: version,
      ...(attachmentVersion ? { attachmentVersion } : {}) }));
    if (bytes) body.append('file', new Blob([bytes]), '测试附件.txt');
    return body;
  }

  // Pre-account schema fixture: migration must retain the existing draft and file.
  const original = Buffer.from('Legacy attachment\0原始字节');
  const changed = Buffer.from('New attachment');
  const dbPath = path.join(dataDir, 'drafts.db');
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(`
    CREATE TABLE drafts (id TEXT PRIMARY KEY, createdAt TEXT NOT NULL, currentVersion INTEGER NOT NULL);
    CREATE TABLE versions (draftId TEXT NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
      version INTEGER NOT NULL, savedAt TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
      category TEXT NOT NULL, fileName TEXT, fileType TEXT, fileData BLOB, PRIMARY KEY(draftId,version));
    CREATE TABLE publications (draftId TEXT PRIMARY KEY REFERENCES drafts(id) ON DELETE CASCADE,
      version INTEGER NOT NULL, publishedAt TEXT NOT NULL);
  `);
  const timestamp = '2026-01-01T00:00:00.000Z';
  legacy.prepare('INSERT INTO drafts VALUES (?,?,?)').run('legacy', timestamp, 1);
  legacy.prepare('INSERT INTO versions VALUES (?,?,?,?,?,?,?,?,?)').run('legacy', 1, timestamp, 'Legacy title', '', 'law', '旧附件.txt', 'text/plain', original);
  legacy.prepare('INSERT INTO publications VALUES (?,?,?)').run('legacy', 1, timestamp);
  legacy.close();
  await start();
  const anon = client(), a = client(), b = client();
  let copied;

  await t.test('legacy data requires explicit first-account claim', async () => {
    assert.deepEqual(await expect(anon, '/api/auth/me', 'GET', undefined, 200), { user: null, needsSetup: true, legacyDraftCount: 1 });
    const unclaimed = await expect(anon, '/api/publications', 'GET', undefined, 200);
    assert.equal(unclaimed.length, 1);
    assert.equal(unclaimed[0].publisher, null);
    assert.deepEqual(Object.keys(unclaimed[0]).sort(), ['category', 'description', 'file', 'id', 'publishedAt', 'publisher', 'title', 'version']);
    await expect(anon, '/api/drafts', 'GET', undefined, 401);
    await expect(anon, '/api/auth/register', 'POST', { username: 'early_user', password }, 409);
    await expect(anon, '/api/auth/setup', 'POST', { username: 'owner_a', password, claimLegacy: false }, 400);
    const setup = await a.request('/api/auth/setup', 'POST', { username: 'Owner_A', password, claimLegacy: true });
    assert.equal(setup.status, 201);
    assert.equal(a.user.username, 'owner_a');
    assert.equal((await expect(anon, '/api/publications', 'GET', undefined, 200))[0].publisher, 'owner_a');
    assert.match(setup.cookie, /HttpOnly; SameSite=Strict; Path=\//);
    assert.match(setup.cookie, /Max-Age=604800/);
    assert.equal((await expect(a, '/api/drafts', 'GET', undefined, 200)).length, 1);
    assert.deepEqual(await expect(a, '/api/drafts/legacy/versions/1/file', 'GET', undefined, 200), original);
    await expect(b, '/api/auth/setup', 'POST', { username: 'owner_b', password, claimLegacy: true }, 409);
    await expect(b, '/api/auth/register', 'POST', { username: 'owner_b', password }, 201);
  });

  await t.test('ownership and stale-page identity are enforced by the server', async () => {
    assert.deepEqual(await expect(b, '/api/drafts', 'GET', undefined, 200), []);
    for (const route of ['/api/drafts/legacy', '/api/drafts/legacy/versions/1/file']) await expect(b, route, 'GET', undefined, 404);
    await expect(b, '/api/drafts/legacy', 'PUT', form('unauthorized', 1), 404);
    await expect(b, '/api/drafts/legacy', 'DELETE', { expectedVersion: 1 }, 404);
    await expect(b, '/api/drafts/legacy/publication', 'PUT', { expectedVersion: 1 }, 404);
    await expect(a, '/api/drafts/new', 'PUT', form('missing identity', 0), 400, { 'X-Studio-User': '' });
    await expect(a, '/api/drafts/new', 'PUT', form('changed account', 0), 403, { 'X-Studio-User': b.user.id });
    await expect(a, '/api/drafts', 'HEAD', undefined, 405, { 'X-Studio-User': '' });
  });

  await t.test('versions append and public copies use the published snapshot', async () => {
    await expect(a, '/api/drafts/legacy', 'PUT', form('Private revision two', 1, changed), 200);
    await expect(a, '/api/drafts/legacy', 'PUT', form('stale writer', 1), 409);
    assert.equal((await expect(anon, '/api/publications', 'GET', undefined, 200))[0].title, 'Legacy title');
    assert.equal((await expect(anon, '/api/publications', 'GET', undefined, 200))[0].publisher, 'owner_a');
    await expect(anon, '/api/publications/legacy/import', 'POST', { expectedPublishedVersion: 1 }, 401);
    await expect(b, '/api/publications/legacy/import', 'POST', { expectedPublishedVersion: 2 }, 409);
    copied = await expect(b, '/api/publications/legacy/import', 'POST', { expectedPublishedVersion: 1, userId: a.user.id }, 201);
    assert.notEqual(copied.id, 'legacy');
    assert.equal(copied.title, 'Legacy title');
    assert.equal(copied.revision, 1);
    assert.equal(copied.versions.length, 1);
    assert.equal(copied.publication, null);
    assert.deepEqual(await expect(b, copied.file.url, 'GET', undefined, 200), original);
    await expect(a, '/api/drafts/' + copied.id, 'GET', undefined, 404);
    await expect(a, '/api/drafts/legacy/publication', 'PUT', { expectedVersion: 2 }, 200);
    await expect(b, '/api/publications/legacy/import', 'POST', { expectedPublishedVersion: 1 }, 409);
    await expect(a, '/api/drafts/legacy/publication', 'DELETE', { expectedPublishedVersion: 2 }, 200);
    await expect(b, '/api/publications/legacy/import', 'POST', { expectedPublishedVersion: 2 }, 404);
    await expect(a, '/api/drafts/legacy', 'DELETE', { expectedVersion: 2 }, 204);
    assert.deepEqual(await expect(b, copied.file.url, 'GET', undefined, 200), original);
  });

  await t.test('failed copies roll back draft, ownership and version together', async () => {
    await expect(b, '/api/drafts/' + copied.id + '/publication', 'PUT', { expectedVersion: 1 }, 200);
    const republished = await expect(anon, '/api/publications', 'GET', undefined, 200);
    assert.equal(republished.length, 1);
    assert.equal(republished[0].publisher, 'owner_b', 'publisher is the sharing account, not the original creator');
    const inspect = new DatabaseSync(dbPath);
    try {
      const before = inspect.prepare('SELECT COUNT(*) AS n FROM drafts').get().n;
      inspect.exec("CREATE TRIGGER fail_copy BEFORE INSERT ON versions BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;");
      await expect(a, '/api/publications/' + copied.id + '/import', 'POST', { expectedPublishedVersion: 1 }, 500);
      assert.equal(inspect.prepare('SELECT COUNT(*) AS n FROM drafts').get().n, before);
      assert.equal(inspect.prepare('SELECT COUNT(*) AS n FROM draft_owners o LEFT JOIN drafts d ON d.id=o.draftId WHERE d.id IS NULL').get().n, 0);
      inspect.exec('DROP TRIGGER fail_copy');
    } finally { inspect.close(); }
  });

  await t.test('password/session storage, rotation, restart and logout', async () => {
    const oldCookie = a.cookie;
    await expect(a, '/api/auth/login', 'POST', { username: 'owner_a', password }, 200);
    assert.notEqual(a.cookie, oldCookie);
    await expect(anon, '/api/drafts', 'GET', undefined, 401, { Cookie: oldCookie });
    const inspect = new DatabaseSync(dbPath);
    try {
      const users = inspect.prepare('SELECT salt,passwordHash FROM users').all();
      assert.equal(users.length, 2);
      assert.notEqual(users[0].salt, users[1].salt);
      for (const user of users) assert.match(user.passwordHash, /^[0-9a-f]{128}$/);
      const tokenHash = createHash('sha256').update(a.cookie.split('=')[1]).digest('hex');
      assert.ok(inspect.prepare('SELECT tokenHash FROM sessions WHERE tokenHash=?').get(tokenHash));
      inspect.prepare('UPDATE sessions SET expiresAt=? WHERE tokenHash=?').run(Date.now() - 1, tokenHash);
    } finally { inspect.close(); }
    await expect(a, '/api/drafts', 'GET', undefined, 401);
    await expect(a, '/api/auth/login', 'POST', { username: 'owner_a', password }, 200);
    await stop();
    await start();
    assert.equal((await expect(a, '/api/auth/me', 'GET', undefined, 200)).user.id, a.user.id);
    assert.equal((await expect(anon, '/api/publications', 'GET', undefined, 200))[0].publisher, 'owner_b');
    assert.deepEqual(await expect(b, copied.file.url, 'GET', undefined, 200), original);
    await expect(a, '/api/auth/logout', 'POST', undefined, 204);
    await expect(a, '/api/drafts', 'GET', undefined, 401);
  });

  await t.test('private files, origin, auth-body limits and attempt limits', async () => {
    for (const route of ['/store.cjs', '/auth.cjs', '/data/drafts.db', '/.cache/not-public']) await expect(anon, route, 'GET', undefined, 404);
    await expect(anon, '/api/publications', 'GET', undefined, 403, { Origin: 'https://example.invalid' });
    const oversized = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(8193) });
    assert.equal(oversized.status, 413);
    let limited = false;
    for (let i = 0; i < 31; i++) {
      if ((await anon.request('/api/auth/login', 'POST', { username: '', password: '' })).status === 429) { limited = true; break; }
    }
    assert.equal(limited, true);
  });
});
