"use strict";
// 顯示設置頁邏輯：僅管理員可用；讀寫 POST /api/settings/display（全局開關）。
// 未登入時顯示引导面板，不直接报错。

const els = {
  needLogin: document.getElementById("need-login"),
  panels: document.getElementById("panels"),
  optDate: document.getElementById("opt-date"),
  optName: document.getElementById("opt-name"),
  saveBtn: document.getElementById("save-btn"),
  saveMsg: document.getElementById("save-msg"),
};

function api(url, options) {
  const opts = Object.assign({ credentials: "same-origin" }, options || {});
  return fetch(url, opts).then(async (res) => {
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    return { status: res.status, data };
  });
}

function detailOf(data, status) {
  if (data && typeof data.detail === "string" && data.detail) return data.detail;
  return "操作失敗（HTTP " + status + "）";
}

function setMsg(text, kind) {
  els.saveMsg.textContent = text;
  els.saveMsg.className = "msg" + (kind ? " " + kind : "");
}

els.saveBtn.addEventListener("click", async () => {
  els.saveBtn.disabled = true;
  setMsg("");
  try {
    const { status, data } = await api("/api/settings/display", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: els.optDate.checked, name: els.optName.checked }),
    });
    if (status === 200 && data && data.ok) {
      setMsg("已保存，主頁即時生效", "ok");
    } else if (status === 401) {
      els.panels.hidden = true;
      els.needLogin.hidden = false;
    } else {
      setMsg(detailOf(data, status), "err");
    }
  } catch (_) {
    setMsg("網絡錯誤，請稍後重試", "err");
  } finally {
    els.saveBtn.disabled = false;
  }
});

(async function init() {
  try {
    const { status, data } = await api("/api/session"); // 契約：恆 200 {"logged_in": bool}
    if (!(status === 200 && data && data.logged_in)) {
      els.needLogin.hidden = false;
      return;
    }
    const settings = await api("/api/settings");
    if (settings.status === 200 && settings.data) {
      const d = settings.data.display || { date: true, name: true };
      els.optDate.checked = Boolean(d.date);
      els.optName.checked = Boolean(d.name);
      els.panels.hidden = false;
    } else {
      els.needLogin.hidden = false;
    }
  } catch (_) {
    els.needLogin.hidden = false;
  }
})();
