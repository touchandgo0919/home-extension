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
      const detail = path === "auth/register" ? await response.json().catch(() => ({})) : {};
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
  const nav = await request("nav", token);
  if (!nav.authenticated) throw fail("Token 无效，请重新登录。", "HTTP_401");
  if (!nav.tenant?.id || !Array.isArray(nav.data) || !nav.data.every(group => Array.isArray(group.links))) {
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
  const { auth: session, lastCategory, operation, registration, backupPending } = await chrome.storage.local.get(["auth", "lastCategory", "operation", "registration", "backupPending"]);
  if (operation?.status === "pending" && !busy) {
    operation.status = "unknown";
    operation.message = "上次保存被中断，结果尚未确认。请刷新检查是否已收藏。";
    await chrome.storage.local.set({ operation });
  }
  return {
    connected: Boolean(session?.token && Date.now() < session.expiresAt), lastCategory, operation, backupPending,
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
    registration = { name, key };
    await chrome.storage.local.set({ registration });
  }
  try {
    const result = await request("auth/register", null, { name: registration.name, registration_key: registration.key });
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
  const operation = { status: "pending", url, title, categoryId, startedAt: Date.now() };
  await chrome.storage.local.set({ operation });
  let postStarted = false;
  try {
    // Refresh before writing: the group or bookmark may have changed in another tab.
    const nav = await navigation(session.token);
    if (!nav.data.some(group => Number(group.id) === categoryId)) throw fail("分组已被删除，请刷新后重试。", "VALIDATION");
    const existing = duplicate(nav, url);
    if (existing) {
      operation.status = "duplicate";
      operation.message = `已收藏在「${existing.category}」，没有重复添加。`;
    } else {
      postStarted = true;
      const result = await request("bookmarks", session.token, { title, url, category_id: categoryId });
      if (!result.id) throw fail("保存结果尚未确认。", "NETWORK");
      operation.status = "saved";
      operation.message = `已保存到「${nav.data.find(group => Number(group.id) === categoryId).category}」。`;
      await chrome.storage.local.set({ lastCategory: categoryId });
    }
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
  if (message.type === "reveal-token") return { token: (await auth()).token };
  if (message.type === "acknowledge-backup") { await chrome.storage.local.set({ backupPending: false }); return {}; }
  if (message.type === "load") {
    const session = await auth();
    const nav = await navigation(session.token);
    const { lastCategory } = await chrome.storage.local.get("lastCategory");
    return { nav, lastCategory };
  }
  if (!["login", "logout", "save", "register"].includes(message.type)) throw fail("不支持的操作。");
  if (busy) throw fail("正在处理上一次操作，请稍候。", "BUSY");
  busy = true;
  try {
    if (message.type === "save") return await save(message);
    if (message.type === "register") return await registerAccount(message);
    if (message.type === "logout") {
      await chrome.storage.local.clear();
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
