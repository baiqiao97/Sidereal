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

// Test-process instrumentation only: observe real HTTP dispatch/close and hold cleanup.
// Windows kill() forcibly terminates processes; emit the registered signal there,
// while Linux CI sends actual OS signals. No test endpoint exists in production.
const preload = `
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const send = message => { if (process.connected) process.send(message); };
const create = http.createServer;
http.createServer = function (...args) {
  const server = create.apply(this, args);
  server.on('request', request => setImmediate(() => send({type:'dispatch',url:request.url})));
  const close = server.close;
  server.close = function (...args) { const result = close.apply(this,args); send({type:'draining'}); return result; };
  return server;
};
const storeModule = require(path.join(process.env.STUDIO_TEST_ROOT,'store.cjs'));
const createStore = storeModule.createStore;
storeModule.createStore = function (...args) {
  const store = createStore(...args), close = store.close;
  store.close = function () {
    fs.appendFileSync(path.join(process.env.STUDIO_TEST_DIR,'closed.log'),'close\\n');
    return close();
  };
  return store;
};
const schedule = global.setTimeout;
let deadline, releaseCleanup;
global.setTimeout = function (callback, delay, ...args) {
  if (delay === 30000) { deadline = callback; send({type:'deadline',delay}); }
  return schedule(callback,delay,...args);
};
if (process.env.STUDIO_TEST_HOLD_CLEANUP === '1') {
  const remove = fs.promises.rm;
  fs.promises.rm = async function (target,...args) {
    if (path.basename(target).startsWith('.backup-')) {
      await new Promise(resolve => { releaseCleanup=resolve; send({type:'cleanup-held'}); });
    }
    return remove.call(this,target,...args);
  };
}
process.on('message', message => {
  if (message.action === 'signal') process.emit(message.signal);
  if (message.action === 'release-cleanup') releaseCleanup();
  if (message.action === 'deadline') deadline();
  send({type:'ack',id:message.id});
});
`;

async function fixture(t, holdCleanup = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sidereal-shutdown-test-'));
  const dbPath = path.join(directory, 'drafts.db');
  const store = createStore(dbPath);
  const owner = await store.auth.setup('shutdown_owner', 'Synthetic-Shutdown-Password!', true);
  store.save('source', { title: 'Original', category: 'notes', expectedVersion: 0 }, null, owner.user.id); store.close();
  const hook = path.join(directory, 'observe.cjs'); await fs.writeFile(hook, preload);
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const env = { ...process.env, STUDIO_TEST_DIR: directory, STUDIO_TEST_ROOT: root, STUDIO_TEST_HOLD_CLEANUP: holdCleanup ? '1' : '0' }; delete env.STUDIO_PUBLIC_ORIGIN;
  const child = spawn(process.execPath, ['--require', hook, path.join(root, 'server.cjs'), root, String(port), directory], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const messages = [], waiters = new Set(), clients = [];
  let stderr = '', controlId = 0;
  child.stderr.on('data', data => { stderr += data; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  child.on('message', message => { messages.push(message); for (const waiter of waiters) if (waiter.matches(message)) { waiters.delete(waiter); waiter.resolve(message); } });
  const wait = (type, predicate = () => true) => {
    const matches = message => message.type === type && predicate(message);
    const existing = messages.find(matches); if (existing) return Promise.resolve(existing);
    return Promise.race([new Promise(resolve => waiters.add({ matches, resolve })), exited.then(result => { throw new Error('Server exited before ' + type + ': ' + JSON.stringify(result)); })]);
  };
  const control = async (action, extra = {}) => {
    const id = ++controlId;
    await new Promise((resolve, reject) => child.send({ action, id, ...extra }, error => error ? reject(error) : resolve()));
    return wait('ack', message => message.id === id);
  };
  const signal = async (name = 'SIGTERM') => {
    if (process.platform === 'win32') await control('signal', { signal: name });
    else assert.equal(child.kill(name), true);
    await wait('draining');
  };
  t.after(async () => {
    clients.forEach(client => client.destroy());
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('sidereal-shutdown-test-'));
    await fs.rm(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => reject(new Error('startup exit ' + code))); child.stdout.once('data', resolve); });
  function upload() {
    const boundary = 'shutdown-test-boundary';
    const attachment = Buffer.from('synthetic saved bytes');
    const body = Buffer.concat([Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n' + JSON.stringify({ title: 'Saved while draining', category: 'notes', expectedVersion: 1 }) + '\r\n--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="saved.txt"\r\nContent-Type: text/plain\r\n\r\n'), attachment, Buffer.from('\r\n--' + boundary + '--\r\n')]);
    let request;
    const result = new Promise(resolve => {
      request = http.request({ host: '127.0.0.1', port, path: '/api/drafts/source', method: 'PUT', agent: false, headers: {
        Cookie: 'sidereal_session=' + owner.token, 'X-Studio-User': owner.user.id,
        'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length
      } }, response => { const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', error => resolve({ error })); response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks) })); });
      request.on('error', error => resolve({ error })); clients.push(request); request.write(body.subarray(0, 16));
    });
    return { request, result, complete: () => request.end(body.subarray(16)), attachment };
  }
  return { directory, dbPath, owner, child, exited, wait, control, signal, upload, messages, clients, port, stderr: () => stderr };
}

test('shutdown drains an accepted upload, rejects new connections and preserves its saved version after restart', { timeout: 20000 }, async t => {
  const run = await fixture(t); const upload = run.upload();
  await run.wait('dispatch', message => message.url === '/api/drafts/source'); await run.signal();
  await run.control('signal', { signal: 'SIGINT' }); await run.control('signal', { signal: 'SIGTERM' });
  await assert.rejects(fetch('http://127.0.0.1:' + run.port + '/api/health'));
  upload.complete(); const response = await upload.result;
  assert.equal(response.status, 200, response.error && response.error.message);
  assert.equal(JSON.parse(response.body).revision, 2);
  assert.deepEqual(await run.exited, { code: 0, signal: null });
  assert.equal(run.messages.filter(message => message.type === 'deadline').length, 1);
  assert.equal(await fs.readFile(path.join(run.directory, 'closed.log'), 'utf8'), 'close\n');
  const reopened = createStore(run.dbPath);
  try { assert.equal(reopened.get('source', run.owner.user.id).revision, 2); assert.deepEqual(reopened.getFile('source', 2, run.owner.user.id).bytes, upload.attachment); } finally { reopened.close(); }
  assert.doesNotMatch(run.stderr(), /not open|内部错误/);
});

test('shutdown waits for backup cleanup after response EOF before closing SQLite', { timeout: 20000 }, async t => {
  const run = await fixture(t, true);
  const response = await fetch('http://127.0.0.1:' + run.port + '/api/drafts/source/backup', { headers: { Cookie: 'sidereal_session=' + run.owner.token } });
  assert.equal(response.status, 200); assert.ok((await response.arrayBuffer()).byteLength > 0);
  await run.wait('cleanup-held'); await run.signal();
  await run.control('signal', { signal: 'SIGTERM' });
  await assert.rejects(fs.readFile(path.join(run.directory, 'closed.log')), { code: 'ENOENT' });
  await run.control('release-cleanup'); assert.deepEqual(await run.exited, { code: 0, signal: null });
  assert.equal((await fs.readdir(run.directory)).some(name => name.startsWith('.backup-')), false);
  assert.equal(await fs.readFile(path.join(run.directory, 'closed.log'), 'utf8'), 'close\n');
});

test('new requests pipelined on a draining connection receive retryable 503', { timeout: 20000 }, async t => {
  const run = await fixture(t);
  const body = Buffer.from('--boundary\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n' + JSON.stringify({ title: 'Pipelined save', category: 'notes', expectedVersion: 1 }) + '\r\n--boundary--\r\n');
  const socket = net.createConnection({ host: '127.0.0.1', port: run.port }); run.clients.push(socket);
  const received = new Promise((resolve, reject) => { const chunks = []; socket.on('data', chunk => chunks.push(chunk)); socket.on('error', reject); socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8'))); });
  await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
  socket.write('PUT /api/drafts/source HTTP/1.1\r\nHost: 127.0.0.1:' + run.port + '\r\nCookie: sidereal_session=' + run.owner.token + '\r\nX-Studio-User: ' + run.owner.user.id + '\r\nContent-Type: multipart/form-data; boundary=boundary\r\nContent-Length: ' + body.length + '\r\n\r\n');
  socket.write(body.subarray(0, 16)); await run.wait('dispatch'); await run.signal();
  socket.write(Buffer.concat([body.subarray(16), Buffer.from('GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:' + run.port + '\r\nConnection: close\r\n\r\n')]));
  const response = await received;
  assert.match(response, /HTTP\/1\.1 200/); assert.match(response, /HTTP\/1\.1 503/);
  assert.match(response, /Retry-After: 1/i); assert.match(response, /Connection: close/i); assert.match(response, /服务正在停止/);
  assert.deepEqual(await run.exited, { code: 0, signal: null });
});

test('the 30 second deadline terminates a stalled request with failure and leaves prior saved data intact', { timeout: 20000 }, async t => {
  const run = await fixture(t); const upload = run.upload();
  await run.wait('dispatch'); await run.signal(); assert.equal((await run.wait('deadline')).delay, 30000);
  // Trigger the registered deadline callback, without spending 30 seconds per CI run.
  const id = 999; await new Promise((resolve, reject) => run.child.send({ action: 'deadline', id }, error => error ? reject(error) : resolve()));
  assert.deepEqual(await run.exited, { code: 1, signal: null });
  const result = await upload.result; assert.ok(result.error || result.status !== 200);
  assert.match(run.stderr(), /30秒/);
  assert.equal(await fs.readFile(path.join(run.directory, 'closed.log'), 'utf8'), 'close\n');
  const reopened = createStore(run.dbPath);
  try { assert.equal(reopened.get('source', run.owner.user.id).revision, 1); assert.equal(reopened.get('source', run.owner.user.id).title, 'Original'); } finally { reopened.close(); }
});

test('idle shutdown exits normally without waiting for the deadline', { timeout: 10000 }, async t => {
  const run = await fixture(t); await run.signal('SIGINT');
  assert.deepEqual(await run.exited, { code: 0, signal: null });
  assert.equal(await fs.readFile(path.join(run.directory, 'closed.log'), 'utf8'), 'close\n');
});
