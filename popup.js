import { translate, resolveLanguage } from "./i18n.js";
const preferences = await chrome.storage.local.get("language");
let language = resolveLanguage(preferences.language, navigator.language);
const t = value => translate(value, language);
document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
// Translate only static UI text before user-owned titles and collection names are inserted.
const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
while (walker.nextNode()) { const node=walker.currentNode; const text=node.textContent.trim(); if(text) node.textContent=node.textContent.replace(text,t(text)); }
for(const node of document.querySelectorAll("[placeholder]")) node.placeholder=t(node.placeholder);
document.title=t(document.title);
for(const link of document.querySelectorAll('a[href$="/help/"],a[href$="/privacy/"]')) link.href += `?lang=${language}`;
const $ = id => document.getElementById(id);
let groups = [];
let selectedCategoryId = null;
let currentPage = null;
let busy = false;
let savedUrl = "";
let poll;
let registrationPoll;
let duplicateBookmark = null;
let checkedUrl = "";
let checkSequence = 0;
let checkTimer;

async function send(type, payload = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...payload });
  if (!result?.ok) throw Object.assign(new Error(result?.error || t("扩展连接中断，请重新打开。")), { code: result?.code });
  return result.data;
}

function status(text, kind = "", loading = false) {
  $("statusText").textContent = t(text);
  $("status").dataset.kind = kind;
  $("spinner").hidden = !loading;
}

function urlKey(value) {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : ""; }
  catch { return ""; }
}

function pageFrom(url, title) {
  const key = urlKey(url);
  if (!key) return null;
  return { url: key, title: String(title || "").trim().slice(0, 500) || new URL(key).hostname };
}

function updateSave() {
  const key = currentPage?.url || "";
  const existing = key === checkedUrl && duplicateBookmark;
  $("duplicateHint").hidden = !existing;
  $("duplicateHint").textContent = existing ? t(`已经收藏在「${existing.category}」。`) : "";
  $("saveButton").disabled = busy || !key || !currentPage?.title || !selectedCategoryId || Boolean(existing) || key === savedUrl;
  $("saveButton").textContent = key && key === savedUrl ? t("已保存") : existing ? t("已收藏") : t("保存当前网页");
}

function setBusy(value) {
  busy = value;
  $("bookmarkFields").disabled = value;
  $("loginButton").disabled = value;
  $("token").disabled = value;
  $("logoutButton").disabled = value;
  $("retryButton").disabled = value;
  for (const id of ["registerButton", "showRegisterButton", "backToLoginButton", "backupTokenButton"]) $(id).disabled = value;
  updateSave();
}

function showLogin() {
  groups = [];
  selectedCategoryId = null;
  savedUrl = "";
  $("loginSection").hidden = false;
  $("bookmarkSection").hidden = true;
  $("registerSection").hidden = true;
  $("backupSection").hidden = true;
  $("backupToken").value = "";
  $("retryButton").hidden = true;
}

function renderNav({ nav, lastCategory }) {
  groups = nav.data;
  checkedUrl = ""; duplicateBookmark = null;
  queueDuplicateCheck();
  $("loginSection").hidden = true;
  $("registerSection").hidden = true;
  $("backupSection").hidden = true;
  $("bookmarkSection").hidden = false;
  $("accountName").textContent = nav.tenant.name;
  const selected = lastCategory || selectedCategoryId;
  selectedCategoryId = groups.find(group => String(group.id) === String(selected))?.id || groups[0]?.id || null;
  $("retryButton").hidden = true;
  status(!groups.length ? t("暂无分组，请先在导航网站创建分组。") : currentPage ? t("点击保存，即可收藏当前网页。") : t("当前页面无法收藏。请打开普通网页后重试。"));
  updateSave();
}

function showError(error) {
  if (error.code === "HTTP_401") showLogin();
  else if (!$("bookmarkSection").hidden) $("retryButton").hidden = false;
  status(error.message || t("操作失败，请重试。"), "error");
}

async function refresh() {
  setBusy(true);
  status(t("正在加载导航分组…"), "", true);
  try { renderNav(await send("load")); }
  catch (error) { showError(error); }
  finally { setBusy(false); }
}

function showOperation(operation) {
  const matches = operation?.url === currentPage?.url;
  if (operation?.status === "pending") {
    setBusy(true);
    status(t("正在保存收藏，关闭窗口后仍会继续…"), "", true);
    poll = setTimeout(checkOperation, 700);
    return;
  }
  setBusy(false);
  if (!matches) {
    status(operation?.status === "saved" ? t("上一个网页已保存，可以继续收藏当前网页。") : t("点击保存，即可收藏当前网页。"));
    return;
  }
  if (["saved", "duplicate"].includes(operation.status)) savedUrl = operation.url;
  status(operation.message, ["saved", "duplicate"].includes(operation.status) ? "success" : "error");
  $("retryButton").hidden = !["unknown", "failed"].includes(operation.status);
  updateSave();
}

async function checkOperation() {
  try { showOperation((await send("state")).operation); }
  catch (error) { setBusy(false); showError(error); }
}

$("loginForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (busy) return;
  const token = $("token").value.trim();
  setBusy(true);
  status(t("正在连接你的导航…"), "", true);
  try { renderNav(await send("login", { token })); $("token").value = ""; }
  catch (error) { showError(error); }
  finally { setBusy(false); }
});

$("bookmarkForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (busy || $("saveButton").disabled) return;
  setBusy(true);
  status(t("正在保存收藏，关闭窗口后仍会继续…"), "", true);
  try { showOperation(await send("save", { title: currentPage.title, url: currentPage.url, categoryId: selectedCategoryId, language })); }
  catch (error) { setBusy(false); showError(error); }
});

$("logoutButton").addEventListener("click", async () => {
  setBusy(true);
  try { await send("logout"); clearTimeout(poll); showLogin(); status(t("已退出，可连接其他账号。")); }
  catch (error) { showError(error); }
  finally { setBusy(false); }
});
$("retryButton").addEventListener("click", refresh);

async function init() {
  setBusy(true);
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentPage = pageFrom(tab?.url, tab?.title);
    const current = await send("state");
    if (current.pendingPage) { currentPage = pageFrom(current.pendingPage.url, current.pendingPage.title); await send("consume-page"); }
    $("onboarding").hidden = Boolean(current.onboarded);
    if (!current.connected) {
      if (current.registration) await resumeRegistration();
      else { showLogin(); status(t("已有 Token 可直接登录，也可以注册个人导航。")); }
      return;
    }
    $("bookmarkSection").hidden = false;
    if (current.operation?.status === "pending") {
      await refresh();
      await checkOperation();
    } else {
      await refresh();
      if (current.operation?.status === "unknown") showOperation(current.operation);
    }
    if (current.backupPending) await showTokenBackup();
  } catch (error) { showLogin(); showError(error); }
  finally { if (!poll && !registrationPoll) setBusy(false); }
}

function showRegistration(registration = null) {
  $("loginSection").hidden = true;
  $("registerSection").hidden = false;
  $("bookmarkSection").hidden = true;
  $("registerName").readOnly = Boolean(registration);
  if (registration) $("registerName").value = registration.name;
  $("registerButton").textContent = registration ? t("继续注册（不会重复创建）") : t("注册并生成 Token");
  status(registration?.message || t("创建个人导航，自动生成登录凭据。"));
}

async function showTokenBackup() {
  const { token } = await send("reveal-token");
  $("backupToken").value = token;
  $("backupToken").type = "password";
  $("revealTokenButton").textContent = t("显示 Token");
  $("bookmarkSection").hidden = true;
  $("backupSection").hidden = false;
  $("retryButton").hidden = true;
  status(t("请妥善保存 Token，不要分享给他人。"));
}

async function resumeRegistration() {
  registrationPoll = null;
  try {
    const current = await send("state");
    if (current.connected) {
      await refresh();
      await showTokenBackup();
      setBusy(false);
    } else if (current.registration?.status === "pending") {
      showRegistration(current.registration);
      setBusy(true);
      status(t("正在创建导航，关闭窗口后仍会继续…"), "", true);
      registrationPoll = setTimeout(resumeRegistration, 700);
    } else {
      showRegistration(current.registration);
      setBusy(false);
    }
  } catch (error) { setBusy(false); showError(error); }
}

$("showRegisterButton").addEventListener("click", async () => {
  try { showRegistration((await send("state")).registration); } catch (error) { showError(error); }
});
$("backToLoginButton").addEventListener("click", () => { clearTimeout(registrationPoll); showLogin(); status(t("输入已有 Token 即可连接。")); });
$("registerForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (busy) return;
  setBusy(true);
  $("registerName").readOnly = true;
  status(t("正在创建导航，关闭窗口后仍会继续…"), "", true);
  try { renderNav(await send("register", { name: $("registerName").value, language })); await showTokenBackup(); }
  catch (error) {
    const current = await send("state").catch(() => ({}));
    showRegistration(current.registration);
    status(error.message, "error");
  } finally { setBusy(false); }
});
$("backupTokenButton").addEventListener("click", () => showTokenBackup().catch(showError));
$("revealTokenButton").addEventListener("click", () => {
  const reveal = $("backupToken").type === "password";
  $("backupToken").type = reveal ? "text" : "password";
  $("revealTokenButton").textContent = reveal ? t("隐藏 Token") : t("显示 Token");
});
$("copyTokenButton").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("backupToken").value); status(t("Token 已复制，请保存到你信任的位置。"), "success"); }
  catch { $("backupToken").type = "text"; $("backupToken").select(); status(t("请按 Ctrl+C 或 ⌘C 复制选中的 Token。")); }
});
$("finishBackupButton").addEventListener("click", async () => {
  try {
    await send("acknowledge-backup");
    $("backupToken").value = "";
    $("backupSection").hidden = true;
    $("bookmarkSection").hidden = false;
    status(t("可以开始收藏当前网页了。"));
  } catch (error) { showError(error); }
});
function queueDuplicateCheck(){clearTimeout(checkTimer);const value=currentPage?.url || "";checkTimer=setTimeout(()=>checkDuplicate(value),200);}
async function checkDuplicate(value){const sequence=++checkSequence;if(!value)return;try{const result=await send("check-url",{url:value});if(sequence!==checkSequence||currentPage?.url!==value)return;checkedUrl=value;duplicateBookmark=result.bookmark;updateSave();}catch{/* Saving still performs an atomic server-side duplicate check. */}}
init();
