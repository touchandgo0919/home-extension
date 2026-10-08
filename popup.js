const $ = id => document.getElementById(id);
let groups = [];
let busy = false;
let savedUrl = "";
let poll;

async function send(type, payload = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...payload });
  if (!result?.ok) throw Object.assign(new Error(result?.error || "扩展连接中断，请重新打开。"), { code: result?.code });
  return result.data;
}

function status(text, kind = "", loading = false) {
  $("statusText").textContent = text;
  $("status").dataset.kind = kind;
  $("spinner").hidden = !loading;
}

function urlKey(value) {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : ""; }
  catch { return ""; }
}

function updateSave() {
  const key = urlKey($("url").value);
  const existing = key && groups.find(group => group.links.some(link => urlKey(link.url) === key));
  $("duplicateHint").hidden = !existing;
  $("duplicateHint").textContent = existing ? `已经收藏在「${existing.category}」。` : "";
  $("saveButton").disabled = busy || !key || !$("title").value.trim() || !$("category").value || Boolean(existing) || key === savedUrl;
  $("saveButton").textContent = key && key === savedUrl ? "已保存" : existing ? "已收藏" : "保存收藏";
}

function setBusy(value) {
  busy = value;
  $("bookmarkFields").disabled = value;
  $("loginButton").disabled = value;
  $("token").disabled = value;
  $("logoutButton").disabled = value;
  $("retryButton").disabled = value;
  updateSave();
}

function showLogin() {
  groups = [];
  savedUrl = "";
  $("loginSection").hidden = false;
  $("bookmarkSection").hidden = true;
  $("retryButton").hidden = true;
}

function renderNav({ nav, lastCategory }) {
  groups = nav.data;
  $("loginSection").hidden = true;
  $("bookmarkSection").hidden = false;
  $("accountName").textContent = nav.tenant.name;
  const selected = lastCategory || $("category").value;
  $("category").replaceChildren(...groups.map(group => new Option(group.category, String(group.id))));
  if (groups.some(group => String(group.id) === String(selected))) $("category").value = String(selected);
  if (!groups.length) $("category").add(new Option("请先在导航中创建分组", ""));
  $("retryButton").hidden = true;
  status(!groups.length ? "暂无分组，请打开导航创建后点击刷新。" : urlKey($("url").value) ? "确认标题和分组后，即可保存。" : "当前页面无法收藏。请切换到普通网页，或手动填写网址。" );
  updateSave();
}

function showError(error) {
  if (error.code === "HTTP_401") showLogin();
  else if (!$("bookmarkSection").hidden) $("retryButton").hidden = false;
  status(error.message || "操作失败，请重试。", "error");
}

async function refresh() {
  setBusy(true);
  status("正在加载导航分组…", "", true);
  try { renderNav(await send("load")); }
  catch (error) { showError(error); }
  finally { setBusy(false); }
}

function showOperation(operation) {
  const matches = operation?.url === urlKey($("url").value);
  if (operation?.status === "pending") {
    setBusy(true);
    status("正在保存收藏，关闭窗口后仍会继续…", "", true);
    poll = setTimeout(checkOperation, 700);
    return;
  }
  setBusy(false);
  if (!matches) {
    status(operation?.status === "saved" ? "上一个网页已保存，可以继续收藏当前网页。" : "确认标题和分组后，即可保存。");
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
  status("正在连接你的导航…", "", true);
  try { renderNav(await send("login", { token })); $("token").value = ""; }
  catch (error) { showError(error); }
  finally { setBusy(false); }
});

$("bookmarkForm").addEventListener("submit", async event => {
  event.preventDefault();
  if (busy || $("saveButton").disabled) return;
  setBusy(true);
  status("正在保存收藏，关闭窗口后仍会继续…", "", true);
  try { showOperation(await send("save", { title: $("title").value, url: $("url").value, categoryId: $("category").value })); }
  catch (error) { setBusy(false); showError(error); }
});

$("logoutButton").addEventListener("click", async () => {
  setBusy(true);
  try { await send("logout"); clearTimeout(poll); showLogin(); status("已退出，可连接其他账号。"); }
  catch (error) { showError(error); }
  finally { setBusy(false); }
});
$("refreshButton").addEventListener("click", refresh);
$("retryButton").addEventListener("click", refresh);
for (const id of ["title", "url", "category"]) $(id).addEventListener("input", updateSave);

async function init() {
  setBusy(true);
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (urlKey(tab?.url)) { $("url").value = tab.url; $("title").value = tab.title || new URL(tab.url).hostname; }
    const current = await send("state");
    if (!current.connected) { showLogin(); status("连接一次，下次即可直接收藏。"); return; }
    $("bookmarkSection").hidden = false;
    if (current.operation?.status === "pending") {
      await refresh();
      await checkOperation();
    } else {
      await refresh();
      if (current.operation?.status === "unknown") showOperation(current.operation);
    }
  } catch (error) { showLogin(); showError(error); }
  finally { if (!poll) setBusy(false); }
}
init();
