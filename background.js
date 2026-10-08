const API = "https://home-api.zhaoyouning.com/api/";
const ready = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
let busy = false;

function fail(message, code = "ERROR") {
  return Object.assign(new Error(message), { code });
}

function webUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw fail("请输入完整的网址。", "VALIDATION"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw fail("仅支持普通 HTTP 或 HTTPS 网页，不支持浏览器设置页和含密码的网址。", "VALIDATION");
  }
  return url.href;
}

async function request(path, token, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(API + path, {
      method: body ? "POST" : "GET",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      const message = typeof detail.error === "string" ? detail.error.slice(0, 200)
        : response.status === 401 ? "Token 无效，请重新登录。"
        : response.status === 403 ? "这个账号没有操作权限。"
        : response.status === 404 ? "分组可能已被删除，请刷新后重试。"
        : "导航服务暂时不可用，请稍后重试。";
      throw fail(message, `HTTP_${response.status}`);
    }
    return await response.json();
  } catch (error) {
    if (error.code && typeof error.code === "string") throw error;
    throw fail(controller.signal.aborted ? "请求超时，请检查网络后重试。" : "无法连接导航，请检查网络后重试。", "NETWORK");
  } finally {
    clearTimeout(timeout);
  }
}

async function navigation(token) {
  const nav = await request("collections", token);
  if (!nav.authenticated) throw fail("Token 无效，请重新登录。", "HTTP_401");
  if (!nav.tenant?.id || !Array.isArray(nav.data)) {
    throw fail("导航数据格式异常，请稍后重试。");
  }
  return nav;
}

async function auth() {
  const { auth: session } = await chrome.storage.local.get("auth");
  if (!session?.token || Date.now() >= session.expiresAt) {
    await chrome.storage.local.remove(["auth", "lastCategory", "operation"]);
    throw fail("请先输入导航 Token。", "HTTP_401");
  }
  return session;
}

function duplicate(nav, url) {
  return nav.data.find(group => group.links.some(link => {
    try { return webUrl(link.url) === url; } catch { return false; }
  }));
}

async function state() {
  const { auth: session, lastCategory, operation, registration, backupPending, pendingPage, onboarded } = await chrome.storage.local.get(["auth", "lastCategory", "operation", "registration", "backupPending", "pendingPage", "onboarded"]);
  if (operation?.status === "pending" && !busy) {
    operation.status = "unknown";
    operation.message = "上次保存被中断，结果尚未确认。请刷新检查是否已收藏。";
    await chrome.storage.local.set({ operation });
  }
  return {
    connected: Boolean(session?.token && Date.now() < session.expiresAt), lastCategory, operation, backupPending, onboarded,
    pendingPage: pendingPage && Date.now()-pendingPage.createdAt<300000 ? pendingPage : null,
    registration: registration ? { name: registration.name, status: busy ? "pending" : "retry", message: registration.message } : null,
  };
}

async function rememberToken(token, backupPending = false) {
  const expires = new Date();
  expires.setFullYear(expires.getFullYear() + 99);
  // Store the credential before clearing retry information, including when the popup closes.
  await chrome.storage.local.set({ auth: { token, expiresAt: expires.getTime() }, backupPending });
  await chrome.storage.local.remove(["lastCategory", "operation", "registration"]);
}

async function registerAccount(input) {
  let { registration, auth: current } = await chrome.storage.local.get(["registration", "auth"]);
  if (current?.token && Date.now() < current.expiresAt) throw fail("请先退出当前账号。", "VALIDATION");
  if (!registration) {
    const name = String(input.name || "").trim();
    if (!name || name.length > 40) throw fail("导航名称需要 1–40 个字符。", "VALIDATION");
    const key = [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    registration = { name, key, language: input.language === "en" ? "en" : "zh" };
    await chrome.storage.local.set({ registration });
  }
  try {
    const result = await request("auth/register", null, { name: registration.name, registration_key: registration.key, language: registration.language });
    if (!/^[a-f0-9]{64}$/.test(result.token || "") || !result.nav?.authenticated || !Array.isArray(result.nav?.data)) {
      throw fail("注册结果暂未确认，请点击继续注册。", "NETWORK");
    }
    await rememberToken(result.token, true);
    return { nav: result.nav };
  } catch (error) {
    registration.message = error.message;
    await chrome.storage.local.set({ registration });
    throw error;
  }
}

async function save(input) {
  const session = await auth();
  const url = webUrl(input.url);
  const title = String(input.title || "").trim();
  const categoryId = Number(input.categoryId);
  if (!title || !Number.isSafeInteger(categoryId) || categoryId < 1) throw fail("请填写标题并选择分组。", "VALIDATION");
  const previous = (await chrome.storage.local.get("operation")).operation;
  const requestId = previous?.status === "unknown" && previous.url === url && previous.title === title && previous.categoryId === categoryId ? previous.requestId : crypto.randomUUID();
  const operation = { status: "pending", url, title, categoryId, requestId, startedAt: Date.now() };
  await chrome.storage.local.set({ operation });
  let postStarted = false;
  try {
    postStarted = true;
    const result = await request("bookmarks", session.token, { title, url, category_id: categoryId, request_id: requestId });
    if (!result.id) throw fail("保存结果尚未确认。", "NETWORK");
    operation.status = result.duplicate ? "duplicate" : "saved";
    operation.message = result.duplicate ? `已收藏在「${result.category || "我的收藏"}」，没有重复添加。` : `已保存到「${result.category || "我的收藏"}」。`;
    await chrome.storage.local.set({ lastCategory: result.category_id || categoryId, onboarded: true });
    await chrome.storage.local.remove("pendingPage");
  } catch (error) {
    const uncertain = postStarted && (error.code === "NETWORK" || /^HTTP_5/.test(error.code || ""));
    operation.status = uncertain ? "unknown" : "failed";
    operation.message = uncertain ? "保存结果尚未确认，请先刷新检查是否已收藏，避免重复添加。" : error.message;
  }
  await chrome.storage.local.set({ operation });
  return operation;
}

async function dispatch(message) {
  await ready;
  if (message.type === "state") return state();
  if (message.type === "consume-page") { await chrome.storage.local.remove("pendingPage"); return {}; }
  if (message.type === "set-language") { if(!["auto","zh","en"].includes(message.language)) throw fail("Invalid language"); await chrome.storage.local.set({language:message.language}); await setupMenus(); return {}; }
  if (message.type === "check-url") return request("bookmarks/check?url=" + encodeURIComponent(webUrl(message.url)), (await auth()).token);
  if (message.type === "reveal-token") return { token: (await auth()).token };
  if (message.type === "acknowledge-backup") { await chrome.storage.local.set({ backupPending: false }); return {}; }
  if (message.type === "load") {
    const session = await auth();
    const nav = await navigation(session.token);
    const { lastCategory } = await chrome.storage.local.get("lastCategory");
    return { nav, lastCategory };
  }
  if (!["login", "logout", "save", "register", "create-category"].includes(message.type)) throw fail("不支持的操作。");
  if (busy) throw fail("正在处理上一次操作，请稍候。", "BUSY");
  busy = true;
  try {
    if (message.type === "save") return await save(message);
    if (message.type === "create-category") return request("categories", (await auth()).token, {name:String(message.name || "").trim()});
    if (message.type === "register") return await registerAccount(message);
    if (message.type === "logout") {
      const { language } = await chrome.storage.local.get("language");
      await chrome.storage.local.clear();
      if(language) await chrome.storage.local.set({language});
      return {};
    }
    const token = String(message.token || "").trim();
    if (!token) throw fail("请输入导航 Token。", "VALIDATION");
    const nav = await navigation(token);
    await rememberToken(token);
    return { nav };
  } finally {
    busy = false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) return false;
  dispatch(message).then(data => respond({ ok: true, data }), error => respond({ ok: false, error: error.message, code: error.code }));
  return true;
});

async function setupMenus() {
  if(!chrome.contextMenus)return;
  const {language}=await chrome.storage.local.get("language");
  const en=language==="en" || (language!=="zh" && !/^zh/i.test(chrome.i18n.getUILanguage()));
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({id:"save-page",title:en?"Save page to My Navigation":"收藏网页到我的导航",contexts:["page"],documentUrlPatterns:["http://*/*","https://*/*"]});
  chrome.contextMenus.create({id:"save-link",title:en?"Save link to My Navigation":"收藏链接到我的导航",contexts:["link"],targetUrlPatterns:["http://*/*","https://*/*"]});
}
chrome.runtime.onInstalled?.addListener(()=>setupMenus().catch(()=>{}));
chrome.runtime.onStartup?.addListener(()=>setupMenus().catch(()=>{}));
chrome.contextMenus?.onClicked.addListener(async(info,tab)=>{
  try {
    const url=webUrl(info.linkUrl || info.pageUrl || tab.url);
    await chrome.storage.local.set({pendingPage:{url,title:info.linkUrl ? info.selectionText || info.linkUrl : tab.title || url,createdAt:Date.now()}});
    await chrome.action.openPopup({windowId:tab.windowId});
  } catch { /* The popup remains available from the toolbar if opening is blocked. */ }
});
