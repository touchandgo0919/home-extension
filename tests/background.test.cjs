const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

function app() {
  const stored = {};
  let listener, menuClick;
  const menus=[],popupWindows=[];
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
  chrome.i18n={getUILanguage:()=> 'en-US'};
  chrome.contextMenus={removeAll:async()=>{menus.length=0;},create:menu=>menus.push(menu),onClicked:{addListener:fn=>menuClick=fn}};
  chrome.action={openPopup:async options=>popupWindows.push(options.windowId)};
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
    if (url.endsWith('/collections')) {
      if (navDelay) await new Promise(resolve => setTimeout(resolve, navDelay));
      return Response.json(options.headers.authorization === 'Bearer test-token'
        ? { authenticated: true, role: 'editor', tenant: { id: 1, name: '测试账号' }, data: groups.map(({links,...g})=>g) }
        : { authenticated: false, data: [] });
    }
    if(url.includes('/bookmarks/check?')) {const key=new URL(url).searchParams.get('url'); const group=groups.find(g=>g.links.some(b=>b.url===key));return Response.json({bookmark:group?{id:10,category:group.category,category_id:group.id}:null});}
    if(url.endsWith('/categories')){const {name}=JSON.parse(options.body);const group={id:groups.length+1,category:name,links:[]};groups.push(group);return Response.json({id:group.id});}
    posts++;
    if(navDelay)await new Promise(resolve=>setTimeout(resolve,navDelay));
    const body = JSON.parse(options.body);
    if (postMode === 'network') throw new TypeError('offline');
    if (postMode === 'server') return new Response('bad gateway', { status: 502 });
    const group=groups.find(g=>g.id===body.category_id);if(!group)return Response.json({error:'Category not found.'},{status:404});
    const existing=groups.find(g=>g.links.some(b=>b.url===body.url));if(existing)return Response.json({id:10,duplicate:true,category:existing.category,category_id:existing.id});
    group.links.push({id:10,...body});
    return Response.json({id:10,category:group.category,category_id:group.id});
  };
  vm.runInNewContext(source, { chrome, fetch, URL, Date, Error, Number, String, Boolean, Array, Object, TextEncoder, setTimeout, clearTimeout, AbortController, crypto:require('node:crypto').webcrypto });
  const send = message => new Promise(resolve => listener(message, { id: 'test-extension', url: 'chrome-extension://test-extension/popup.html' }, resolve));
  return { stored, send, menus, popupWindows, menuClick:(info,tab)=>menuClick(info,tab), registrationRequests, registrations, login: () => send({ type: 'login', token: 'test-token' }), get posts() { return posts; }, get groups() { return groups; }, set registrationFailure(value) { registrationFailure = value; }, set postMode(value) { postMode = value; }, set groups(value) { groups = value; }, set navDelay(value) { navDelay = value; } };
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
  assert.equal(a.posts, 2);
  assert.equal(a.groups[1].links.length,1);
});

test('internal URLs are rejected locally and removed groups are rejected by the server', async () => {
  const a = app(); await a.login();
  for (const url of ['chrome://settings', 'file:///private/data', 'javascript:alert(1)', 'https://user:password@example.com/']) {
    assert.equal((await a.send({ ...bookmark, url })).ok, false);
  }
  assert.equal(a.posts,0);
  a.groups = [];
  assert.equal((await a.send(bookmark)).data.status, 'failed');
  assert.equal(a.posts, 1);
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


test('collection creation and URL checks use lightweight endpoints',async()=>{
 const a=app();await a.login();const group=await a.send({type:'create-category',name:'New'});assert.equal(group.data.id,3);
 const loaded=await a.send({type:'load'});assert.equal(loaded.data.nav.data[0].links,undefined);
 await a.send(bookmark);const checked=await a.send({type:'check-url',url:bookmark.url});assert.equal(checked.data.bookmark.category_id,2);
});
test('cached collections appear in state and are cleared on account sign-out',async()=>{
 const a=app();await a.login();
 assert.equal((await a.send({type:'state'})).data.navCache.data[0].category,'工作');
 a.groups=[...a.groups,{id:3,category:'新分组',links:[]}];
 assert.equal((await a.send({type:'load'})).data.nav.data[2].category,'新分组');
 assert.equal((await a.send({type:'state'})).data.navCache.data[2].category,'新分组');
 await a.send({type:'logout'});
 assert.equal((await a.send({type:'state'})).data.navCache,null);
 assert.equal(a.stored.navCache,undefined);
});
test('an old collection response cannot repopulate the cache after sign-out',async()=>{
 const a=app();await a.login();a.navDelay=30;
 const loading=a.send({type:'load'});
 await new Promise(resolve=>setTimeout(resolve,5));
 await a.send({type:'logout'});
 assert.equal((await loading).code,'HTTP_401');
 assert.equal(a.stored.navCache,undefined);
});
test('uncertain saves reuse their request ID when explicitly retried',async()=>{
 const a=app();await a.login();a.postMode='network';await a.send(bookmark);const key=a.stored.operation.requestId;
 a.postMode='success';await a.send(bookmark);assert.equal(a.stored.operation.requestId,key);assert.equal(a.stored.operation.status,'saved');
});
test('English and Chinese UI translation preserves user collection names',async()=>{
 const {translate,resolveLanguage}=await import('../i18n.js');assert.equal(resolveLanguage('auto','en-US'),'en');assert.equal(resolveLanguage('zh','en-US'),'zh');assert.equal(translate('保存收藏','en'),'Save bookmark');assert.equal(translate('已保存到「我的工作」。','en'),'Saved to “我的工作”.');assert.equal(translate('保存收藏','zh'),'保存收藏');
});

test('context menus stage the selected link without writing and preserve the source window',async()=>{
 const a=app();await a.send({type:'set-language',language:'en'});assert.equal(a.menus.length,2);assert.match(a.menus[1].title,/Save link/);
 await a.menuClick({menuItemId:'save-link',linkUrl:'https://selected.example/path',pageUrl:'https://source.example/'},{windowId:7,title:'Source page'});
 assert.equal(a.stored.pendingPage.url,'https://selected.example/path');assert.equal(a.popupWindows[0],7);assert.equal(a.posts,0);
 assert.equal((await a.send({type:'state'})).data.pendingPage.url,'https://selected.example/path');
 await a.send({type:'consume-page'});assert.equal(a.stored.pendingPage,undefined);
 await a.menuClick({linkUrl:'javascript:alert(1)'},{windowId:7});assert.equal(a.stored.pendingPage,undefined);
 await a.send({type:'set-language',language:'zh'});assert.match(a.menus[0].title,/收藏网页/);
});
