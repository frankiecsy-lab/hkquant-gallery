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
    els.viewMsg, els.pwdMsg, els.deleteAllMsg, els.logoutMsg);
  els.deleteAllForm.hidden = true;
  els.loginPassword.focus();
}

function showPanels(settings) {
  els.loginCard.hidden = true;
  els.panels.hidden = false;
  applySettings(settings);
  loadStorage();
}

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

// ---------- ⑦ 登出 ----------

els.logoutBtn.addEventListener("click", () => {
  withBusy(els.logoutBtn, async () => {
    const { status, data } = await postJson("/api/logout", {});
    // 契約：後端恆回 {"ok":true}；即便異常也退回登入卡，避免卡死
    if (status === 200 || !data || data.ok) {
      showLogin();
      setMsg(els.loginMsg, I18N.t("admin.loggedOut"), "ok");
    } else {
      setMsg(els.logoutMsg, detailOf(data, status), "err");
    }
  });
});

// ---------- 語言切換：面板內動態文字（當前標題／台區／容量）即時重渲染 ----------

document.addEventListener("i18n:lang", () => {
  if (lastSettings) applySettings(lastSettings);
  if (lastStorage) renderStorageText();
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
