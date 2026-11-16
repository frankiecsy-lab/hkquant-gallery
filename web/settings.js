"use strict";
// 全局設置頁：界面語言（繁中／英文）、主頁內容（相片／視頻）、縮略圖資訊（日期／檔名）、
// 排序方式、資料夾可見性（複選）。任何變更即時自動保存；全部僅管理員可用，
// 未登入顯示引導面板。對應端點：POST /api/settings/lang|display|sort|folders。

const els = {
  needLogin: document.getElementById("need-login"),
  panels: document.getElementById("panels"),
  langZh: document.getElementById("lang-zh"),
  langEn: document.getElementById("lang-en"),
  optPhotos: document.getElementById("opt-photos"),
  optVideos: document.getElementById("opt-videos"),
  optDate: document.getElementById("opt-date"),
  optName: document.getElementById("opt-name"),
  contentHint: document.getElementById("content-hint"),
  sortByTime: document.getElementById("sort-by-time"),
  sortByName: document.getElementById("sort-by-name"),
  sortDesc: document.getElementById("sort-desc"),
  sortAsc: document.getElementById("sort-asc"),
  folderList: document.getElementById("folder-list"),
  saveBtn: document.getElementById("save-btn"),
  saveMsg: document.getElementById("save-msg"),
};

let lastSettings = null; // 快取設定資料，語言切換時重建資料夾清單等動態文字

function api(url, options) {
  const opts = Object.assign({ credentials: "same-origin" }, options || {});
  return fetch(url, opts).then(async (res) => {
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    return { status: res.status, data };
  });
}

function postJson(url, body) {
  return api(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function detailOf(data, status) {
  if (data && typeof data.detail === "string" && data.detail) return I18N.detail(data.detail);
  return I18N.t("common.httpFail", { status });
}

function setMsg(text, kind) {
  els.saveMsg.textContent = text;
  els.saveMsg.className = "msg" + (kind ? " " + kind : "");
}

function backToLogin() {
  els.panels.hidden = true;
  els.needLogin.hidden = false;
}

// 界面語言：保存到服務端並即時套用到本頁（I18N.setLang 會廣播 i18n:lang）
async function saveLang() {
  setMsg("");
  const lang = els.langEn.checked ? "en" : "zh";
  const { status, data } = await postJson("/api/settings/lang", { lang });
  if (status === 200 && data && data.ok) {
    I18N.setLang(data.lang);
    setMsg(I18N.t("settings.langSaved"), "ok");
  } else if (status === 401) {
    backToLogin();
  } else {
    setMsg(detailOf(data, status), "err");
  }
}

async function saveDisplay() {
  setMsg("");
  const { status, data } = await postJson("/api/settings/display", {
    date: els.optDate.checked,
    name: els.optName.checked,
    photos: els.optPhotos.checked,
    videos: els.optVideos.checked,
  });
  if (status === 200 && data && data.ok) {
    setMsg(I18N.t("settings.displaySaved"), "ok");
    updateContentHint(data.display);
  } else if (status === 401) {
    backToLogin();
  } else {
    setMsg(detailOf(data, status), "err");
  }
}

async function saveSort() {
  setMsg("");
  const by = els.sortByName.checked ? "name" : "captured";
  const desc = els.sortDesc.checked;
  const { status, data } = await postJson("/api/settings/sort", { by, desc });
  if (status === 200 && data && data.ok) {
    setMsg(I18N.t("settings.sortSaved"), "ok");
  } else if (status === 401) {
    backToLogin();
  } else {
    setMsg(detailOf(data, status), "err");
  }
}

function folderChecks() {
  return Array.from(els.folderList.querySelectorAll("input[type=checkbox]"));
}

async function saveFolders() {
  setMsg("");
  const boxes = folderChecks();
  const checked = boxes.filter((b) => b.checked).map((b) => b.value);
  const { status, data } = await postJson("/api/settings/folders", {
    folders: checked.length === boxes.length ? null : checked, // 全選＝全部可見
  });
  if (status === 200 && data && data.ok) {
    if (lastSettings) lastSettings.visible_folders = data.visible_folders;
    setMsg(checked.length === 0
      ? I18N.t("settings.foldersNone")
      : I18N.t("settings.foldersSaved"), checked.length === 0 ? "err" : "ok");
    if (checked.length === 0) boxes.forEach((b) => { b.checked = true; });
  } else if (status === 401) {
    backToLogin();
  } else {
    setMsg(detailOf(data, status), "err");
  }
}

function updateContentHint(d) {
  if (!d) return;
  els.contentHint.textContent = !d.photos && !d.videos ? I18N.t("settings.bothOff") : "";
}

function buildFolderList(allFolders, visible) {
  els.folderList.textContent = "";
  if (!allFolders.length) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = I18N.t("settings.noFolders");
    els.folderList.appendChild(p);
    return;
  }
  for (const name of allFolders) {
    const label = document.createElement("label");
    label.className = "check-row";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = name;
    box.checked = visible === null || visible === undefined || visible.includes(name);
    box.addEventListener("change", saveFolders);
    const span = document.createElement("span");
    span.textContent = name === "（根目錄）" ? I18N.t("footer.root") : name;
    label.append(box, span);
    els.folderList.appendChild(label);
  }
}

async function saveAll() {
  els.saveBtn.disabled = true;
  try {
    await saveLang();
    await saveDisplay();
    await saveSort();
    await saveFolders();
  } finally {
    els.saveBtn.disabled = false;
  }
}

// 全部開關即時自動保存
for (const el of [els.langZh, els.langEn]) {
  el.addEventListener("change", saveLang);
}
for (const el of [els.optPhotos, els.optVideos, els.optDate, els.optName]) {
  el.addEventListener("change", saveDisplay);
}
for (const el of [els.sortByTime, els.sortByName, els.sortDesc, els.sortAsc]) {
  el.addEventListener("change", saveSort);
}
els.saveBtn.addEventListener("click", saveAll);

// 語言切換：重建含動態文字的清單與提示（靜態標籤由 I18N.applyDom 處理）
document.addEventListener("i18n:lang", () => {
  if (lastSettings) {
    updateContentHint(lastSettings.display);
    buildFolderList(lastSettings.all_folders || [], lastSettings.visible_folders);
  }
});

(async function init() {
  await I18N.init();
  try {
    const { status, data } = await api("/api/session"); // 契約：恆 200 {"logged_in": bool}
    if (!(status === 200 && data && data.logged_in)) {
      els.needLogin.hidden = false;
      return;
    }
    const settings = await api("/api/settings");
    if (settings.status === 200 && settings.data) {
      lastSettings = settings.data;
      const d = settings.data.display || {};
      els.optPhotos.checked = d.photos !== false;
      els.optVideos.checked = d.videos !== false;
      els.optDate.checked = Boolean(d.date);
      els.optName.checked = Boolean(d.name);
      updateContentHint(d);
      const sort = settings.data.sort || { by: "captured", desc: true };
      els.sortByName.checked = sort.by === "name";
      els.sortByTime.checked = sort.by !== "name";
      els.sortDesc.checked = Boolean(sort.desc);
      els.sortAsc.checked = !sort.desc;
      els.langEn.checked = settings.data.lang === "en";
      els.langZh.checked = settings.data.lang !== "en";
      buildFolderList(settings.data.all_folders || [], settings.data.visible_folders);
      els.panels.hidden = false;
    } else {
      els.needLogin.hidden = false;
    }
  } catch (_) {
    els.needLogin.hidden = false;
  }
})();
