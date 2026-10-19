const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const sourcePath = path.resolve(__dirname, '../app.js');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const draft = (id = 'source', title = 'Saved source', revision = 1) => ({ id, title, description: 'Saved description', category: 'notes', revision,
  createdAt: 1, updatedAt: 1, file: null, publication: { version: 1 },
  versions: Array.from({ length: revision }, (_, i) => ({ version: i + 1, title: title + i, description: '', category: 'notes', savedAt: 1, file: null })) });

// Run the complete application with a small DOM and controlled network promises.
// It exercises actual click handlers without depending on a browser package in CI.
async function harness() {
  class Node {
    constructor(tag = 'div') { this.tag = tag; this.hidden = true; this.disabled = false; this.handlers = {}; this.children = []; this.files = []; this._value = ''; this._text = ''; this.classList = { toggle() {}, remove() {} }; }
    set value(value) { this._value = value; if (this.id === 'fileInput' && value === '') this.files = []; }
    get value() { return this._value; }
    set textContent(value) { this._text = value; this.children = []; }
    get textContent() { return this._text; }
    addEventListener(name, handler) { this.handlers[name] = handler; }
    appendChild(child) { this.children.push(child); return child; }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(selector === 'button' && child.tag === 'button' ? [child] : []), ...child.querySelectorAll(selector)]); }
    reportValidity() { return true; }
    scrollIntoView() {}
    focus() {}
  }
  const nodes = {}, get = id => nodes[id] ||= Object.assign(new Node(), { id });
  get('materialForm').elements = { description: get('description'), category: get('category') };
  get('materialForm').reset = () => { get('materialTitle').value = ''; get('description').value = ''; get('category').value = 'notes'; };
  get('category').value = 'notes';
  const api = { health: async () => ({ ok: true }), list: async () => [], get: async () => draft(), put: async () => draft(),
    listTrash: async () => [], getUsage: async () => ({ activeDrafts: 0, trashedDrafts: 0, versions: 0, attachmentBytes: 0 }), setUser() {}, publish: async () => draft(), unpublish: async () => draft() };
  let hooks, canWrite = true;
  const initialized = deferred();
  const context = vm.createContext({
    document: { getElementById: get, createElement: tag => new Node(tag), querySelectorAll: () => [] },
    window: { confirm: () => true }, localStorage: { getItem: () => 'server' }, serverApi: api,
    createAccountUi(nextHooks) { hooks = nextHooks; return { canWrite: () => canWrite, initialize: async () => {
      try { await hooks.onAuthenticated({ id: 'owner', username: 'owner' }); initialized.resolve(); } catch (error) { initialized.reject(error); throw error; }
    } }; }
  });
  vm.runInContext(await fs.readFile(sourcePath, 'utf8'), context);
  await initialized.promise;
  const call = (name, ...args) => { context.testArgs = args; return vm.runInContext(name + '(...testArgs)', context); };
  const expire = () => { canWrite = false; hooks.onRequired(); };
  const fill = (title, file) => { get('materialTitle').value = title; get('description').value = 'Unsaved description'; get('fileInput').files = file ? [file] : []; };
  return { api, nodes, call, expire, fill, save: () => get('saveDraftButton').handlers.click(), state: () => vm.runInContext('({editingId, editingRevision, operationBusy, attachmentRemoved})', context) };
}

test('a late successful save cannot clear unsaved files or reveal private lists after login expires', async () => {
  const h = await harness(), sent = deferred(), response = deferred();
  h.api.put = record => { sent.resolve(record); return response.promise; };
  h.fill('Original input', { name: 'sent.txt' }); const saving = h.save(); const record = await sent.promise;
  h.expire(); const later = { name: 'later.txt' }; h.fill('Later input', later);
  let reads = 0; h.api.list = async () => { reads++; return [draft('old_private')]; };
  response.resolve(draft(record.id)); await saving;
  assert.equal(h.nodes.fileInput.files[0], later); assert.equal(h.nodes.materialTitle.value, 'Later input');
  assert.equal(h.nodes.librarySection.hidden, true); assert.equal(reads, 0);
  assert.equal(h.state().editingId, null); assert.equal(h.state().operationBusy, false);
  assert.match(h.nodes.storageStatus.textContent, /请先登录/);
});

test('late edit and history reads cannot replace the editor or reopen private history after sign-out', async () => {
  for (const action of ['startEdit', 'openHistory']) {
    const h = await harness(), response = deferred(); h.api.get = () => response.promise;
    const pending = h.call(action, 'source'); h.expire(); const file = { name: 'unsaved.txt' }; h.fill('Keep this input', file);
    response.resolve(draft()); await pending;
    assert.equal(h.nodes.materialTitle.value, 'Keep this input', action); assert.equal(h.nodes.fileInput.files[0], file, action);
    assert.equal(h.nodes.historySection.hidden, true, action); assert.equal(h.nodes.librarySection.hidden, true, action);
  }
});

test('late history restoration cannot overwrite a new editor after login expires', async () => {
  const h = await harness(); await h.call('openHistory', 'source');
  const sent = deferred(), response = deferred(); h.api.put = record => { sent.resolve(record); return response.promise; };
  const pending = h.call('restoreVersion', 'source', 1); await sent.promise;
  h.expire(); const file = { name: 'keep.txt' }; h.fill('Keep restoration input', file);
  response.resolve(draft('source', 'Restored old title', 2)); await pending;
  assert.equal(h.nodes.materialTitle.value, 'Keep restoration input'); assert.equal(h.nodes.fileInput.files[0], file);
  assert.equal(h.nodes.historySection.hidden, true); assert.equal(h.nodes.librarySection.hidden, true); assert.equal(h.state().operationBusy, false);
});

test('late publication results and failures do not replace the sign-in notice or reload private data', async () => {
  for (const action of ['publishDraft', 'unpublishDraft']) for (const success of [true, false]) {
    const h = await harness(), response = deferred(); h.api[action === 'publishDraft' ? 'publish' : 'unpublish'] = () => response.promise;
    const pending = h.call(action, draft()); h.expire(); let reads = 0; h.api.list = async () => { reads++; return [draft()]; };
    if (success) response.resolve(draft()); else response.reject(new Error('Old request failure'));
    await pending;
    assert.match(h.nodes.storageStatus.textContent, /请先登录/); assert.equal(h.nodes.draftError.hidden, true);
    assert.equal(reads, 0); assert.equal(h.nodes.librarySection.hidden, true); assert.equal(h.state().operationBusy, false);
  }
});

test('saving leaves a newly selected attachment available for the next version', async () => {
  const h = await harness(), sent = deferred(), response = deferred();
  h.api.put = record => { sent.resolve(record); return response.promise; };
  h.fill('New draft', { name: 'first.txt' }); const saving = h.save(); const first = await sent.promise;
  const later = { name: 'second.txt' }; h.nodes.fileInput.files = [later];
  response.resolve(draft(first.id)); await saving;
  assert.equal(h.nodes.fileInput.files[0], later); assert.equal(h.state().editingId, first.id);
  let second; h.api.put = async record => { second = record; return draft(first.id, 'New draft', 2); };
  await h.save(); assert.equal(second.file.blob, later); assert.equal(second.id, first.id);
  assert.equal(h.nodes.fileInput.files.length, 0, 'the unchanged submitted selection is cleared after success');
});

test('removing the saved attachment during a pending save is retained for the next save', async () => {
  const h = await harness(); const attached = { ...draft(), file: { name: 'saved.txt', version: 1 } };
  h.api.get = async () => attached; await h.call('startEdit', 'source');
  const sent = deferred(), response = deferred(); h.api.put = record => { sent.resolve(record); return response.promise; };
  const saving = h.save(); await sent.promise; h.nodes.removeAttachment.handlers.click();
  const saved = { ...draft('source', 'Saved source', 2), file: attached.file };
  response.resolve(saved); await saving; h.api.get = async () => saved;
  assert.equal(h.state().attachmentRemoved, true);
  let next; h.api.put = async record => { next = record; return draft('source', 'without attachment', 3); };
  await h.save(); assert.equal(next.file, null);
});

test('rapid edit/history selection keeps the latest requested record and closing history invalidates its read', async () => {
  for (const action of ['startEdit', 'openHistory']) {
    const h = await harness(), older = deferred(); h.api.get = id => id === 'older' ? older.promise : Promise.resolve(draft(id, 'Latest record'));
    const first = h.call(action, 'older'); await h.call(action, 'latest'); older.resolve(draft('older', 'Old record')); await first;
    if (action === 'startEdit') assert.equal(h.state().editingId, 'latest');
    else assert.match(h.nodes.historyDraftLabel.textContent, /Latest record/);
  }
  const h = await harness(), pendingRead = deferred(); h.api.get = () => pendingRead.promise;
  const pending = h.call('openHistory', 'source'); h.call('closeHistory'); pendingRead.resolve(draft()); await pending;
  assert.equal(h.nodes.historySection.hidden, true);
});

test('starting a new draft or saving invalidates earlier editor reads', async () => {
  for (const action of ['startEdit', 'openHistory']) {
    const h = await harness(), response = deferred(); h.api.get = () => response.promise;
    const pending = h.call(action, 'source'); h.call('clearEditor'); const file = { name: 'new-draft.txt' }; h.fill('New draft input', file);
    response.resolve(draft()); await pending;
    assert.equal(h.nodes.materialTitle.value, 'New draft input'); assert.equal(h.nodes.fileInput.files[0], file);
    assert.equal(h.state().editingId, null); assert.equal(h.nodes.historySection.hidden, true);
  }
  const h = await harness(), response = deferred(); h.api.get = () => response.promise;
  const pending = h.call('startEdit', 'source'); h.fill('Save this new draft'); await h.save(); const savedId = h.state().editingId;
  response.resolve(draft()); await pending; assert.equal(h.state().editingId, savedId); assert.equal(h.nodes.materialTitle.value, 'Save this new draft');
});
