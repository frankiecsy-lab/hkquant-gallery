"use strict";
// 管理頁邏輯：以 GET /api/session 決定登入狀態；未登入顯示登入卡，
// 登入後顯示圖庫資料夾、修改密碼與登出三塊面板。
// 嚴格遵循 API 契約：fetch 一律 credentials:'same-origin'；不直接操作 cookie；
// 錯誤提示直接顯示後端 {"detail": "..."} 於對應面板，不使用 alert()。

const els = {
  loginCard: document.getElementById("login-card"),
  panels: document.getElementById("panels"),
  loginForm: document.getElementById("login-form"),
  loginPassword: document.getElementById("login-password"),
  loginSubmit: document.getElementById("login-submit"),
  loginMsg: document.getElementById("login-msg"),
  rootForm: document.getElementById("root-form"),
  rootInput: document.getElementById("root-input"),
  rootCurrent: document.getElementById("root-current"),
  rootSubmit: document.getElementById("root-submit"),
  rootMsg: document.getElementById("root-msg"),
  titleForm: document.getElementById("title-form"),
  titleInput: document.getElementById("title-input"),
  titleCurrent: document.getElementById("title-current"),
  titleSubmit: document.getElementById("title-submit"),
  titleMsg: document.getElementById("title-msg"),
  storageBar: document.getElementById("storage-bar"),
  storageText: document.getElementById("storage-text"),
  storageMsg: document.getElementById("storage-msg"),
  viewForm: document.getElementById("view-form"),
  viewCode: document.getElementById("view-code"),
  viewCode2: document.getElementById("view-code2"),
  viewSave: document.getElementById("view-save"),
  viewToggle: document.getElementById("view-toggle"),
  viewCurrent: document.getElementById("view-current"),
  viewMsg: document.getElementById("view-msg"),
  pwdForm: document.getElementById("pwd-form"),
  pwdOld: document.getElementById("pwd-old"),
  pwdNew: document.getElementById("pwd-new"),
  pwdConfirm: document.getElementById("pwd-confirm"),
  pwdSubmit: document.getElementById("pwd-submit"),
  pwdMsg: document.getElementById("pwd-msg"),
  faceStatus: document.getElementById("face-status"),
  faceRebuild: document.getElementById("face-rebuild"),
  faceIdleForm: document.getElementById("face-idle-form"),
  faceIdle: document.getElementById("face-idle"),
  faceIdleSave: document.getElementById("face-idle-save"),
  faceMsg: document.getElementById("face-msg"),
  dlState: document.getElementById("dl-state"),
  dlToggle: document.getElementById("dl-toggle"),
  dlMsg: document.getElementById("dl-msg"),
  faceAutoForm: document.getElementById("face-auto-form"),
  faceAutoMin: document.getElementById("face-auto-min"),
  faceAutoToggle: document.getElementById("face-auto-toggle"),
  faceAutoState: document.getElementById("face-auto-state"),
  statsSummary: document.getElementById("stats-summary"),
  statsDays: document.getElementById("stats-days"),
  statsLabels: document.getElementById("stats-labels"),
  statsLog: document.getElementById("stats-log"),
  statsReset: document.getElementById("stats-reset"),
  statsMsg: document.getElementById("stats-msg"),
  deleteAllBtn: document.getElementById("delete-all-btn"),
  deleteAllForm: document.getElementById("delete-all-form"),
  deleteAllPw: document.getElementById("delete-all-pw"),
  deleteAllConfirm: document.getElementById("delete-all-confirm"),
  deleteAllMsg: document.getElementById("delete-all-msg"),
  logoutBtn: document.getElementById("logout-btn"),
  logoutMsg: document.getElementById("logout-msg"),
};

// 統一 fetch：自帶 same-origin cookie，回傳 {status, data}，data 為解析後的 JSON（失敗則 null）
async function api(url, options) {
  const opts = Object.assign({ credentials: "same-origin" }, options || {});
  const res = await fetch(url, opts);
  let data = null;
  try { data = await res.json(); } catch (_) { data = null; }
  return { status: res.status, data };
}

// POST JSON 協助函式（契約要求 Content-Type: application/json）
function postJson(url, body) {
  return api(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// 從後端回應取出可直接顯示的錯誤文字（契約格式 {"detail": "..."}，英文模式下映射常見訊息）
function detailOf(data, status) {
  if (data && typeof data.detail === "string" && data.detail) return I18N.detail(data.detail);
  return I18N.t("common.httpFail", { status });
}

function setMsg(el, text, kind) {
  el.textContent = text;
  el.className = "msg" + (kind ? " " + kind : "");
}

function clearMsg(...nodes) {
  for (const el of nodes) { el.textContent = ""; el.className = "msg"; }
}

// 提交期間禁用按鈕，防止重複送出
function withBusy(btn, job) {
  btn.disabled = true;
  return job().finally(() => { btn.disabled = false; });
}

function showLogin() {
  els.panels.hidden = true;
  els.loginCard.hidden = false;
  els.loginPassword.value = "";
  clearMsg(els.loginMsg, els.rootMsg, els.titleMsg, els.storageMsg,
    els.viewMsg, els.pwdMsg, els.faceMsg, els.dlMsg, els.statsMsg, els.deleteAllMsg, els.logoutMsg);
  els.deleteAllForm.hidden = true;
  els.loginPassword.focus();
}

function showPanels(settings) {
  els.loginCard.hidden = true;
  els.panels.hidden = false;
  let savedTab = "general";
  try { savedTab = sessionStorage.getItem("gallery.adminTab") || "general"; } catch (_) { /* 隱私模式容忍 */ }
  showTab(TAB_NAMES.includes(savedTab) ? savedTab : "general");
  applySettings(settings);
  loadStorage();
  loadFaceStatus();
  loadStats();
}

// ---------- Tab 分類（常規／人臉／下載與統計／危險；所選 tab 記憶於 sessionStorage） ----------

const TAB_NAMES = ["general", "face", "dlstats", "danger"];
const tabBtns = Array.from(document.querySelectorAll(".tab-btn"));

function showTab(name) {
  for (const b of tabBtns) b.classList.toggle("active", b.dataset.tab === name);
  for (const p of document.querySelectorAll(".tab-pane")) p.hidden = p.id !== "tab-" + name;
  try { sessionStorage.setItem("gallery.adminTab", name); } catch (_) { /* 隱私模式容忍 */ }
}

for (const b of tabBtns) b.addEventListener("click", () => showTab(b.dataset.tab));

// 查看闸门当前状态（来自 GET／POST /api/settings、/api/settings/view）
let viewEnabled = false;
let viewHasCode = false;
let lastSettings = null;   // 快取最近設定，語言切換時即時重渲染
let lastStorage = null;

// 將 GET／POST /api/settings/root 回傳的 root_label 與 title 顯示於面板
function applySettings(settings) {
  if (settings) lastSettings = settings;
  const label = settings && settings.root_label ? settings.root_label : "—";
  els.rootCurrent.textContent = I18N.t("admin.rootCurrent") + label;
  if (settings && typeof settings.title === "string") {
    els.titleCurrent.textContent = I18N.t("admin.titleCurrent") + settings.title;
    if (!els.titleInput.value) els.titleInput.value = settings.title;
  }
  if (settings && typeof settings.view_enabled === "boolean") {
    updateViewPanel(settings.view_enabled, settings.view_has_code);
  }
  if (settings && typeof settings.downloads === "boolean") {
    renderDlPanel(settings.downloads);
  }
}

// 批量下載面板（全站開關；GET／POST /api/settings[.downloads] 同 /api/settings/downloads）
let dlEnabled = false;

function renderDlPanel(enabled) {
  dlEnabled = Boolean(enabled);
  if (lastSettings) lastSettings.downloads = dlEnabled;
  els.dlState.textContent = I18N.t("admin.dlCurrent")
    + I18N.t(dlEnabled ? "admin.dlOn" : "admin.dlOff");
  els.dlToggle.textContent = I18N.t(dlEnabled ? "admin.dlDisable" : "admin.dlEnable");
}

function updateViewPanel(enabled, hasCode) {
  viewEnabled = !!enabled;
  viewHasCode = !!hasCode;
  if (lastSettings) {
    lastSettings.view_enabled = viewEnabled;
    lastSettings.view_has_code = viewHasCode;
  }
  els.viewCurrent.textContent = I18N.t("admin.viewCurrent")
    + (viewEnabled ? I18N.t("admin.enabled") : I18N.t("admin.disabled"))
    + " · " + (viewHasCode ? I18N.t("admin.hasCode") : I18N.t("admin.noCode"));
  els.viewToggle.textContent = viewEnabled ? I18N.t("admin.disableGate") : I18N.t("admin.enableGate");
}

// 字节数转可读单位（B/KB/MB/GB/TB）
function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return (n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)) + " " + units[i];
}

// ---------- FTP 儲存容量 ----------

function renderStorageText() {
  if (!lastStorage) return;
  const pct = Math.min(100, (lastStorage.used / lastStorage.limit) * 100);
  els.storageText.textContent = I18N.t("admin.storageUsed", {
    u: fmtBytes(lastStorage.used), l: fmtBytes(lastStorage.limit),
    f: fmtBytes(lastStorage.free), p: pct.toFixed(1),
  });
}

async function loadStorage() {
  els.storageText.textContent = I18N.t("admin.reading");
  try {
    const { status, data } = await api("/api/storage");
    if (status === 200 && data && Number.isFinite(data.limit) && data.limit > 0) {
      const pct = Math.min(100, (data.used / data.limit) * 100);
      els.storageBar.style.width = pct.toFixed(1) + "%";
      els.storageBar.classList.toggle("warn", pct >= 80);
      lastStorage = data;
      renderStorageText();
    } else {
      els.storageText.textContent = I18N.t("admin.storageFail") + detailOf(data, status);
    }
  } catch (_) {
    els.storageText.textContent = I18N.t("admin.storageFail") + I18N.t("common.networkErr");
  }
}

// 取得當前設定；401（未登入／過期）時退回登入卡
async function loadSettings() {
  const { status, data } = await api("/api/settings");
  if (status === 200 && data) {
    showPanels(data);
  } else if (status === 401) {
    showLogin();
  } else {
    showLogin();
    setMsg(els.loginMsg, detailOf(data, status), "err");
  }
}

// ---------- ① 登入 ----------

els.loginForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const password = els.loginPassword.value;
  if (!password) {
    setMsg(els.loginMsg, I18N.t("admin.pwNeed"), "err");
    return;
  }
  clearMsg(els.loginMsg);
  withBusy(els.loginSubmit, async () => {
    const { status, data } = await postJson("/api/login", { password });
    if (status === 200 && data && data.ok) {
      els.loginPassword.value = "";
      await loadSettings(); // 登入成功後拉取設定並切換到面板
    } else {
      setMsg(els.loginMsg, detailOf(data, status), "err");
    }
  });
});

// ---------- ② 圖庫資料夾 ----------

els.rootForm.addEventListener("submit", (e) => {
  e.preventDefault();
  // 留空代表 FTP 根目錄，契約以 "." 表示
  const root = els.rootInput.value.trim() || ".";
  clearMsg(els.rootMsg);
  withBusy(els.rootSubmit, async () => {
    const { status, data } = await postJson("/api/settings/root", { root });
    if (status === 200 && data && data.ok) {
      applySettings(data);
      els.rootInput.value = "";
      setMsg(els.rootMsg, I18N.t("common.saved"), "ok");
    } else if (status === 401) {
      showLogin();
    } else {
      setMsg(els.rootMsg, detailOf(data, status), "err");
    }
  });
});

// ---------- ③ 主頁標題 ----------

els.titleForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const title = els.titleInput.value.trim();
  if (!title) {
    setMsg(els.titleMsg, I18N.t("admin.titleNeed"), "err");
    return;
  }
  if (title.length > 80) {
    setMsg(els.titleMsg, I18N.t("admin.titleMax"), "err");
    return;
  }
  clearMsg(els.titleMsg);
  withBusy(els.titleSubmit, async () => {
    const { status, data } = await postJson("/api/settings/title", { title });
    if (status === 200 && data && data.ok) {
      els.titleCurrent.textContent = I18N.t("admin.titleCurrent") + data.title;
      if (lastSettings) lastSettings.title = data.title;
      setMsg(els.titleMsg, I18N.t("common.saved"), "ok");
    } else if (status === 401) {
      showLogin();
    } else {
      setMsg(els.titleMsg, detailOf(data, status), "err");
    }
  });
});

// ---------- ④ 查看密碼（啟用後訪客需輸入數字密碼才可看相） ----------

els.viewForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const code = els.viewCode.value.trim();
  const code2 = els.viewCode2.value.trim();
  if (!/^\d{4,12}$/.test(code)) {
    setMsg(els.viewMsg, I18N.t("admin.codeFormat"), "err");
    return;
  }
  if (code !== code2) {
    setMsg(els.viewMsg, I18N.t("admin.codeMismatch"), "err");
    return;
  }
  clearMsg(els.viewMsg);
  withBusy(els.viewSave, async () => {
    // 只改密碼，不改開關狀態（enabled 保持當前值）
    const { status, data } = await postJson("/api/settings/view", { enabled: viewEnabled, code });
    if (status === 200 && data && data.ok) {
      els.viewCode.value = "";
      els.viewCode2.value = "";
      updateViewPanel(data.view_enabled, data.view_has_code);
      setMsg(els.viewMsg, I18N.t("admin.codeSaved") + (viewEnabled ? I18N.t("admin.codeSavedNow") : ""), "ok");
    } else if (status === 401) {
      showLogin();
    } else {
      setMsg(els.viewMsg, detailOf(data, status), "err");
    }
  });
});

els.viewToggle.addEventListener("click", () => {
  clearMsg(els.viewMsg);
  withBusy(els.viewToggle, async () => {
    const { status, data } = await postJson("/api/settings/view", { enabled: !viewEnabled, code: "" });
    if (status === 200 && data && data.ok) {
      updateViewPanel(data.view_enabled, data.view_has_code);
      setMsg(els.viewMsg, data.view_enabled ? I18N.t("admin.gateOnMsg") : I18N.t("admin.gateOffMsg"), "ok");
    } else if (status === 401) {
      showLogin();
    } else {
      setMsg(els.viewMsg, detailOf(data, status), "err");
    }
  });
});

// ---------- 批量下載開關 ----------

els.dlToggle.addEventListener("click", () => {
  clearMsg(els.dlMsg);
  withBusy(els.dlToggle, async () => {
    const { status, data } = await postJson("/api/settings/downloads", { enabled: !dlEnabled });
    if (status === 200 && data && data.ok) {
      renderDlPanel(data.downloads);
      setMsg(els.dlMsg, I18N.t("admin.dlSaved"), "ok");
    } else if (status === 401) {
      showLogin();
    } else {
      setMsg(els.dlMsg, detailOf(data, status), "err");
    }
  });
});

// ---------- ⑤ 修改密碼 ----------

els.pwdForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const oldPassword = els.pwdOld.value;
  const newPassword = els.pwdNew.value;
  const confirm = els.pwdConfirm.value;

  // 前端先行校驗：新密碼至少 8 個字符且兩次一致，通過才送出
  if (!oldPassword) {
    setMsg(els.pwdMsg, I18N.t("admin.oldNeed"), "err");
    return;
  }
  if (newPassword.length < 8) {
    setMsg(els.pwdMsg, I18N.t("admin.pwShort"), "err");
    return;
  }
  if (newPassword !== confirm) {
    setMsg(els.pwdMsg, I18N.t("admin.pwMismatch"), "err");
    return;
  }
  clearMsg(els.pwdMsg);
  withBusy(els.pwdSubmit, async () => {
    const { status, data } = await postJson("/api/settings/password", {
      old_password: oldPassword,
      new_password: newPassword,
    });
    if (status === 200 && data && data.ok) {
      els.pwdOld.value = "";
      els.pwdNew.value = "";
      els.pwdConfirm.value = "";
      setMsg(els.pwdMsg, I18N.t("admin.pwUpdated"), "ok");
    } else if (status === 401) {
      showLogin();
    } else {
      setMsg(els.pwdMsg, detailOf(data, status), "err");
    }
  });
});

// ---------- ⑥ 危險區域：一鍵全部刪除（管理密碼二次確認） ----------

els.deleteAllBtn.addEventListener("click", () => {
  clearMsg(els.deleteAllMsg);
  els.deleteAllForm.hidden = false;
  els.deleteAllPw.focus();
});

els.deleteAllForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const password = els.deleteAllPw.value;
  if (!password) {
    setMsg(els.deleteAllMsg, I18N.t("admin.adminPwNeed"), "err");
    return;
  }
  clearMsg(els.deleteAllMsg);
  withBusy(els.deleteAllConfirm, async () => {
    const { status, data } = await postJson("/api/photo/delete_all", { password });
    if (status === 200 && data && data.ok) {
      els.deleteAllPw.value = "";
      els.deleteAllForm.hidden = true;
      setMsg(els.deleteAllMsg, I18N.t("admin.deletedN", { n: data.deleted }), "ok");
      loadStorage();
    } else if (status === 401) {
      showLogin();
    } else {
      setMsg(els.deleteAllMsg, detailOf(data, status), "err");
    }
  });
});

// ---------- ⑥ 人臉索引 ----------

let lastFace = null;        // 快取 GET /api/face/status，語言切換即時重渲染
let facePollTimer = null;

function renderFaceStatus() {
  renderFaceAuto(); // 定時索引設置與模型狀態無關，恒先渲染
  if (!lastFace) return;
  if (!lastFace.models) {
    els.faceStatus.textContent = I18N.t("admin.faceNoModels");
    els.faceRebuild.disabled = true;
    return;
  }
  els.faceRebuild.disabled = lastFace.running;
  // 回填闲置卸载分钟数（用户正在输入时不打断）
  if (Number.isInteger(lastFace.idle_unload_minutes)
      && document.activeElement !== els.faceIdle) {
    els.faceIdle.value = String(lastFace.idle_unload_minutes);
  }
  let text = I18N.t("admin.faceStatus",
    { indexed: lastFace.indexed, total: lastFace.total_images });
  if (lastFace.running) {
    text += " · " + I18N.t("admin.faceRunning", { done: lastFace.done, todo: lastFace.todo });
  }
  if (lastFace.errors > 0) text += I18N.t("admin.faceErrors", { n: lastFace.errors });
  els.faceStatus.textContent = text;
}

// ---------- 人臉定時索引（開關＋間隔分鐘；POST /api/face/auto） ----------

let faceAuto = { enabled: false, minutes: 10 };

function renderFaceAuto() {
  const auto = lastFace && lastFace.auto_index;
  if (auto) faceAuto = { enabled: Boolean(auto.enabled), minutes: Number(auto.minutes) || 10 };
  els.faceAutoState.textContent = faceAuto.enabled
    ? I18N.t("admin.faceAutoOn", { n: faceAuto.minutes })
    : I18N.t("admin.faceAutoOff");
  els.faceAutoToggle.textContent = I18N.t(faceAuto.enabled ? "admin.faceAutoDisable" : "admin.faceAutoEnable");
  if (document.activeElement !== els.faceAutoMin) {
    els.faceAutoMin.value = String(faceAuto.minutes);
  }
}

async function postFaceAuto(enabled, minutes) {
  clearMsg(els.faceMsg);
  const { status, data } = await postJson("/api/face/auto", { enabled, minutes });
  if (status === 200 && data && data.ok) {
    faceAuto = { enabled: data.enabled, minutes: data.minutes };
    if (lastFace) lastFace.auto_index = { enabled: data.enabled, minutes: data.minutes };
    renderFaceAuto();
    setMsg(els.faceMsg, I18N.t("admin.faceAutoSaved"), "ok");
  } else if (status === 401) {
    showLogin();
  } else {
    setMsg(els.faceMsg, detailOf(data, status), "err");
  }
}

els.faceAutoToggle.addEventListener("click", () => postFaceAuto(!faceAuto.enabled, faceAuto.minutes));

els.faceAutoForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const mins = parseInt(els.faceAutoMin.value, 10);
  if (!Number.isInteger(mins) || mins < 5 || mins > 1440) {
    setMsg(els.faceMsg, I18N.t("admin.faceAutoBad"), "err");
    return;
  }
  postFaceAuto(faceAuto.enabled, mins);
});

// ---------- 訪問統計（GET /api/stats；重置需二次確認） ----------

let lastStats = null;

function fillRows(host, rows) {
  host.textContent = "";
  if (!rows.length) {
    const p = document.createElement("p");
    p.textContent = I18N.t("admin.statsNone");
    host.appendChild(p);
    return;
  }
  for (const r of rows) {
    const p = document.createElement("p");
    p.textContent = r;
    host.appendChild(p);
  }
}

function renderStatsText() {
  if (!lastStats) return;
  els.statsSummary.textContent = I18N.t("admin.statsTotal", { n: lastStats.total })
    + (lastStats.started
      ? " · " + I18N.t("admin.statsStarted", { t: String(lastStats.started).replace("T", " ").slice(0, 16) })
      : "");
  fillRows(els.statsDays, (lastStats.days || []).slice().reverse().map((d) =>
    d.date + " · " + I18N.t("admin.statsDay",
      { n: d.total || 0, m: d.mobile || 0, p: d.tablet || 0, d: d.desktop || 0, b: d.bot || 0 })));
  fillRows(els.statsLabels, Object.entries(lastStats.labels || {}).map(([k, v]) => k + " ×" + v));
  fillRows(els.statsLog, (lastStats.log || []).map((r) => r.ts + " · " + r.label));
}

async function loadStats() {
  const { status, data } = await api("/api/stats");
  if (status === 200 && data) {
    lastStats = data;
    renderStatsText();
  } else if (status === 401) {
    showLogin();
  }
}

let statsArmed = false;
let statsArmTimer = 0;

function disarmStats() {
  statsArmed = false;
  clearTimeout(statsArmTimer);
  els.statsReset.textContent = I18N.t("admin.statsReset");
}

els.statsReset.addEventListener("click", () => {
  if (!statsArmed) {
    statsArmed = true;
    els.statsReset.textContent = I18N.t("admin.statsResetConfirm");
    statsArmTimer = setTimeout(disarmStats, 3000);
    return;
  }
  disarmStats();
  clearMsg(els.statsMsg);
  withBusy(els.statsReset, async () => {
    const { status, data } = await postJson("/api/stats/reset", {});
    if (status === 200 && data && data.ok) {
      setMsg(els.statsMsg, I18N.t("admin.statsResetted"), "ok");
      await loadStats();
    } else if (status === 401) {
      showLogin();
    } else {
      setMsg(els.statsMsg, detailOf(data, status), "err");
    }
  });
});

async function loadFaceStatus() {
  try {
    const { status, data } = await api("/api/face/status");
    if (status === 200 && data) {
      lastFace = data;
      renderFaceStatus();
      // 索引進行中：4 秒輪詢直至完成
      clearTimeout(facePollTimer);
      if (data.running) facePollTimer = setTimeout(loadFaceStatus, 4000);
    }
  } catch (_) { /* 面板保持上一次狀態 */ }
}

els.faceIdleForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const minutes = parseInt(els.faceIdle.value, 10);
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 240) {
    setMsg(els.faceMsg, I18N.t("admin.faceUnloadBad"), "err");
    return;
  }
  clearMsg(els.faceMsg);
  withBusy(els.faceIdleSave, async () => {
    const { status, data } = await postJson("/api/face/unload", { minutes });
    if (status === 200 && data && data.ok) {
      setMsg(els.faceMsg, I18N.t("admin.faceUnloadSaved"), "ok");
      loadFaceStatus();
    } else {
      setMsg(els.faceMsg, detailOf(data, status), "err");
    }
  });
});

els.faceRebuild.addEventListener("click", () => {
  withBusy(els.faceRebuild, async () => {
    const { status, data } = await postJson("/api/face/index", {});
    if (status === 200 && data && data.ok) {
      setMsg(els.faceMsg,
        data.started ? I18N.t("admin.faceStarted") : I18N.t("admin.faceUpToDate"), "ok");
      loadFaceStatus();
    } else {
      setMsg(els.faceMsg, detailOf(data, status), "err");
    }
  });
});

// ---------- ⑦ 登出 ----------

els.logoutBtn.addEventListener("click", () => {
  withBusy(els.logoutBtn, async () => {
    const { status, data } = await postJson("/api/logout", {});
    // 契約：後端恆回 {"ok":true}；成功即返回主頁（首頁自動還原頁碼），異常才退回登入卡
    if (status === 200 || !data || data.ok) {
      showLogin();
      setMsg(els.loginMsg, I18N.t("admin.loggedOut"), "ok");
      setTimeout(() => { location.href = "/"; }, 600);
    } else {
      setMsg(els.logoutMsg, detailOf(data, status), "err");
    }
  });
});

// ---------- 語言切換：面板內動態文字（當前標題／台區／容量）即時重渲染 ----------

document.addEventListener("i18n:lang", () => {
  if (lastSettings) applySettings(lastSettings);
  if (lastStorage) renderStorageText();
  if (lastFace) renderFaceStatus();
  if (lastStats) renderStatsText();
});

// ---------- 初始化：先取語言，再查 session 決定顯示登入卡或面板 ----------

(async function init() {
  await I18N.init();
  try {
    const { status, data } = await api("/api/session"); // 契約：恆 200 {"logged_in": bool}
    if (status === 200 && data && data.logged_in) {
      await loadSettings();
    } else {
      showLogin();
    }
  } catch (_) {
    showLogin();
    setMsg(els.loginMsg, I18N.t("common.netRetry"), "err");
  }
})();
