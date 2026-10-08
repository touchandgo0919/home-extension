const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

function app() {
  const stored = {};
  let listener;
  let postMode = 'success';
  let posts = 0;
  let navDelay = 0;
  let registrationFailure = false;
  const registrations = new Map();
  const registrationRequests = [];
  let groups = [{ id: 1, category: '工作', links: [] }, { id: 2, category: '学习', links: [] }];
  const storage = {
    async setAccessLevel() {},
    async get(keys) { return structuredClone(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in stored).map(key => [key, stored[key]]))); },
    async set(data) { Object.assign(stored, structuredClone(data)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete stored[key]; },
    async clear() { for (const key of Object.keys(stored)) delete stored[key]; },
  };
  const chrome = { storage: { local: storage }, runtime: { id: 'test-extension', getURL: value => `chrome-extension://test-extension/${value}`, onMessage: { addListener(fn) { listener = fn; } } } };
  const fetch = async (url, options) => {
    assert.ok(url.startsWith('https://home-api.zhaoyouning.com/api/'));
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    if (url.endsWith('/auth/register')) {
      assert.equal(options.headers.authorization, undefined);
      const body = JSON.parse(options.body);
      registrationRequests.push(body);
      if (!registrations.has(body.registration_key)) registrations.set(body.registration_key, 'b'.repeat(64));
      if (registrationFailure) { registrationFailure = false; throw new TypeError('response lost'); }
      return Response.json({token:registrations.get(body.registration_key),nav:{authenticated:true,role:'editor',tenant:{id:2,name:body.name},data:groups}});
    }
    if (url.endsWith('/nav')) {
      if (navDelay) await new Promise(resolve => setTimeout(resolve, navDelay));
      return Response.json(options.headers.authorization === 'Bearer test-token'
        ? { authenticated: true, role: 'editor', tenant: { id: 1, name: '测试账号' }, data: groups }
        : { authenticated: false, data: [] });
    }
    posts++;
    const body = JSON.parse(options.body);
    if (postMode === 'network') throw new TypeError('offline');
    if (postMode === 'server') return new Response('bad gateway', { status: 502 });
    groups.find(group => group.id === body.category_id).links.push({ id: 10, ...body });
    return Response.json({ id: 10 });
  };
  vm.runInNewContext(source, { chrome, fetch, URL, Date, Error, Number, String, Boolean, Array, Object, setTimeout, clearTimeout, AbortController, crypto:require('node:crypto').webcrypto });
  const send = message => new Promise(resolve => listener(message, { id: 'test-extension', url: 'chrome-extension://test-extension/popup.html' }, resolve));
  return { stored, send, registrationRequests, registrations, login: () => send({ type: 'login', token: 'test-token' }), get posts() { return posts; }, set registrationFailure(value) { registrationFailure = value; }, set postMode(value) { postMode = value; }, set groups(value) { groups = value; }, set navDelay(value) { navDelay = value; } };
}
const bookmark = { type: 'save', title: 'Example', url: 'https://example.com/', categoryId: 2 };

test('invalid login is rejected; successful login persists 99 years without returning the token', async () => {
  const a = app();
  assert.equal((await a.send({ type: 'login', token: 'invalid' })).code, 'HTTP_401');
  assert.equal(a.stored.auth, undefined);
  const login = await a.login();
  assert.equal(login.ok, true);
  assert.equal(JSON.stringify(login).includes('test-token'), false);
  assert.equal(new Date(a.stored.auth.expiresAt).getFullYear(), new Date().getFullYear() + 99);
});

test('save writes one bookmark, remembers group, and blocks duplicates even after popup reopens', async () => {
  const a = app(); await a.login();
  assert.equal((await a.send(bookmark)).data.status, 'saved');
  assert.equal(a.stored.lastCategory, 2);
  assert.equal((await a.send(bookmark)).data.status, 'duplicate');
  assert.equal(a.posts, 1);
});

test('browser/internal URLs and removed groups never reach the write endpoint', async () => {
  const a = app(); await a.login();
  for (const url of ['chrome://settings', 'file:///private/data', 'javascript:alert(1)', 'https://user:password@example.com/']) {
    assert.equal((await a.send({ ...bookmark, url })).ok, false);
  }
  a.groups = [];
  assert.equal((await a.send(bookmark)).data.status, 'failed');
  assert.equal(a.posts, 0);
});

test('overlapping saves and account switches are blocked while a write is active', async () => {
  const a = app(); await a.login(); a.navDelay = 30;
  const first = a.send(bookmark);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await a.send(bookmark)).code, 'BUSY');
  assert.equal((await a.send({ type: 'logout' })).code, 'BUSY');
  assert.equal((await first).data.status, 'saved');
  assert.equal(a.posts, 1);
});

test('an uncertain write is reported without an automatic retry', async () => {
  for (const mode of ['network', 'server']) {
    const a = app(); await a.login(); a.postMode = mode;
    assert.equal((await a.send(bookmark)).data.status, 'unknown');
    assert.equal(a.posts, 1);
  }
});

test('interrupted pending operation is recoverable; logout removes local account data', async () => {
  const a = app(); await a.login();
  a.stored.operation = { status: 'pending', url: bookmark.url };
  assert.equal((await a.send({ type: 'state' })).data.operation.status, 'unknown');
  await a.send({ type: 'logout' });
  assert.deepEqual(a.stored, {});
  assert.equal((await a.send({ type: 'load' })).code, 'HTTP_401');
});

test('registration logs in automatically and exposes the generated token only on an explicit backup request', async () => {
  const a=app();
  const response=await a.send({type:'register',name:'新用户'});
  assert.equal(response.ok,true);
  assert.equal(a.stored.auth.token,'b'.repeat(64));
  assert.equal(a.stored.backupPending,true);
  assert.equal(a.stored.registration,undefined);
  assert.equal(JSON.stringify(response).includes('b'.repeat(64)),false);
  assert.equal(JSON.stringify(await a.send({type:'state'})).includes('b'.repeat(64)),false);
  assert.equal((await a.send({type:'reveal-token'})).data.token,'b'.repeat(64));
  await a.send({type:'acknowledge-backup'});
  assert.equal(a.stored.backupPending,false);
});

test('lost registration response retains a secret nonce and reuses it without creating a second account', async () => {
  const a=app(); a.registrationFailure=true;
  assert.equal((await a.send({type:'register',name:'新用户'})).ok,false);
  const key=a.stored.registration.key;
  assert.match(key,/^[a-f0-9]{64}$/);
  const state=await a.send({type:'state'});
  assert.equal(state.data.registration.status,'retry');
  assert.equal(JSON.stringify(state).includes(key),false);
  assert.equal((await a.send({type:'register',name:'重试改名不会创建新账号'})).ok,true);
  assert.equal(a.registrationRequests[1].registration_key,key);
  assert.equal(a.registrationRequests[1].name,'新用户');
  assert.equal(a.registrations.size,1);
});
