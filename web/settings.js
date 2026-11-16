"use strict";
// 顯示設置頁（所有訪客可用，無需登入）：界面語言、主頁內容（相片／視頻）、縮略圖資訊、
// 排序方式——全部保存在本瀏覽器 Cookie（GET/POST /api/prefs），任何變更即時自動保存。
// 「顯示資料夾」屬全局設置僅管理員可見（GET /api/settings＋POST /api/settings/folders）。
// 「返回主頁」直接跳回首頁（首頁自行還原之前頁碼）。

const els = {
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
  folderPanel: document.getElementById("folder-panel"),
  folderList: document.getElementById("folder-list"),
  backHomeBtn: document.getElementById("back-home-btn"),
  saveMsg: document.getElementById("save-msg"),
};

let lastPrefs = null;    // 最近一次生效的訪客設置（語言切換時重渲染提示）
let lastSettings = null; // 管理員資料夾面板資料

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

// 訪客偏好寫入 Cookie：成功時服務端回傳合併後的完整設置
async function savePrefs(payload, okKey) {
  setMsg("");
  const { status, data } = await postJson("/api/prefs", payload);
  if (status === 200 && data && data.ok) {
    lastPrefs = { lang: data.lang, display: data.display, sort: data.sort };
    setMsg(I18N.t(okKey), "ok");
    updateContentHint(data.display);
    return data;
  }
  setMsg(detailOf(data, status), "err");
  return null;
}

// 界面語言：寫入 Cookie 並即時套用到本頁（I18N.setLang 會廣播 i18n:lang）
async function saveLang() {
  const lang = els.langEn.checked ? "en" : "zh";
  const data = await savePrefs({ lang }, "settings.langSaved");
  if (data) I18N.setLang(data.lang);
}

async function saveDisplay() {
  await savePrefs({
    display: {
      date: els.optDate.checked,
      name: els.optName.checked,
      photos: els.optPhotos.checked,
      videos: els.optVideos.checked,
    },
  }, "settings.displaySaved");
}

async function saveSort() {
  await savePrefs({
    sort: { by: els.sortByName.checked ? "name" : "captured", desc: els.sortDesc.checked },
  }, "settings.sortSaved");
}

function folderChecks() {
  return Array.from(els.folderList.querySelectorAll("input[type=checkbox]"));
}

// 資料夾可見性：全局設置（僅管理員面板可見）
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

els.backHomeBtn.addEventListener("click", () => {
  location.href = "/"; // 所有開關已自動保存，直接返主頁（首頁還原頁碼）
});

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

// 語言切換：重建含動態文字的清單與提示（靜態標籤由 I18N.applyDom 處理）
document.addEventListener("i18n:lang", () => {
  if (lastPrefs) updateContentHint(lastPrefs.display);
  if (lastSettings) buildFolderList(lastSettings.all_folders || [], lastSettings.visible_folders);
});

(async function init() {
  await I18N.init();
  try {
    const { status, data } = await api("/api/prefs");
    if (status === 200 && data) {
      lastPrefs = data;
      els.optPhotos.checked = data.display.photos !== false;
      els.optVideos.checked = data.display.videos !== false;
      els.optDate.checked = Boolean(data.display.date);
      els.optName.checked = Boolean(data.display.name);
      updateContentHint(data.display);
      const sort = data.sort || { by: "captured", desc: true };
      els.sortByName.checked = sort.by === "name";
      els.sortByTime.checked = sort.by !== "name";
      els.sortDesc.checked = Boolean(sort.desc);
      els.sortAsc.checked = !sort.desc;
      els.langEn.checked = data.lang === "en";
      els.langZh.checked = data.lang !== "en";
      if (data.is_admin) {
        // 管理員額外顯示全局資料夾面板
        const settings = await api("/api/settings");
        if (settings.status === 200 && settings.data) {
          lastSettings = settings.data;
          els.folderPanel.hidden = false;
          buildFolderList(settings.data.all_folders || [], settings.data.visible_folders);
        }
      }
    }
  } catch (_) {
    setMsg(I18N.t("common.netRetry"), "err");
  }
})();
