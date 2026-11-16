"use strict";
// 圖庫首頁邏輯：讀取 /api/gallery 後以「資料夾篩選＋排序＋分頁」展示圖片，
// 縮略圖走 /thumb（失敗回退 /media 原圖），卡片可疊加拍攝日期／檔名（設置頁控制）。
// 管理員登入狀態下每張卡片附「隱藏／刪除（二次確認）」按鈕。
// 篩選、排序、分頁為純前端行為，偏好持久化於 localStorage。
// 嚴格遵循 API 契約：fetch 一律 credentials:'same-origin'；path 未 encode，
// 拼 URL 時逐段 encodeURIComponent；錯誤提示直接顯示後端 detail。

const els = {
  title: document.getElementById("gallery-title"),
  status: document.getElementById("status"),
  toolbar: document.getElementById("toolbar"),
  folderChips: document.getElementById("folder-chips"),
  sortName: document.getElementById("sort-name"),
  sortTime: document.getElementById("sort-time"),
  sortDir: document.getElementById("sort-dir"),
  gallery: document.getElementById("gallery"),
  pager: document.getElementById("pager"),
  footSign: document.getElementById("foot-sign"),
  footStats: document.getElementById("foot-stats"),
  footFolders: document.getElementById("foot-folders"),
  lightbox: document.getElementById("lightbox"),
  lbImg: document.getElementById("lb-img"),
  lbName: document.getElementById("lb-name"),
  lbIndex: document.getElementById("lb-index"),
  lbClose: document.getElementById("lb-close"),
  lbPrev: document.getElementById("lb-prev"),
  lbNext: document.getElementById("lb-next"),
  gate: document.getElementById("gate"),
  gateDots: document.getElementById("gate-dots"),
  gateMsg: document.getElementById("gate-msg"),
  gatePad: document.getElementById("gate-pad"),
};

const PREF_KEY = "hqgal…refs";
const PAGE_SIZE = 60;

// 使用者偏好：folder（""=全部；"（根目錄）"=根）、排序欄位與方向
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREF_KEY));
    if (p && typeof p === "object") {
      return {
        folder: typeof p.folder === "string" ? p.folder : "",
        sortKey: p.sortKey === "name" ? "name" : "time",
        sortDir: p.sortDir === "asc" ? "asc" : "desc",
      };
    }
  } catch (_) { /* 忽略損壞的偏好 */ }
  return { folder: "", sortKey: "time", sortDir: "desc" }; // 默認：全部＋時間反序（最新在前）
}
function savePrefs() {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (_) {}
}

const prefs = loadPrefs();

// 全量圖片清單（扁平化，含所屬 folder 與管理用 key/hidden）
let allItems = [];
let folders = [];      // 來自 API 的資料夾清單（含可見計數）
let items = [];        // 當前篩選＋排序結果（未分頁）
let pageItems = [];    // 當前頁可見清單（lightbox 序號來源）
let page = 1;
let isAdmin = false;
let display = { date: true, name: true };
let stats = null;
let current = -1;

// 將契約中的未 encode POSIX 路徑轉為 URL（逐段 encodeURIComponent）
function mediaUrl(path) {
  return "/media/" + String(path).split("/").map(encodeURIComponent).join("/");
}
function thumbUrl(path) {
  return "/thumb/" + String(path).split("/").map(encodeURIComponent).join("/");
}

// 統一 fetch：自帶 same-origin cookie，回傳 {status, data}，data 為解析後的 JSON（失敗則 null）
function api(url, options) {
  const opts = Object.assign({ credentials: "same-origin" }, options || {});
  return fetch(url, opts).then(async (res) => {
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    return { status: res.status, data };
  });
}

// 從後端回應取出可直接顯示的錯誤文字（契約格式 {"detail": "..."}）
function detailOf(data, status) {
  if (data && typeof data.detail === "string" && data.detail) return data.detail;
  return "請求失敗（HTTP " + status + "）";
}

function setStatus(text, kind) {
  els.status.textContent = text;
  els.status.className = "status" + (kind ? " " + kind : "");
  els.status.hidden = !text;
}

function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return (n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)) + " " + units[i];
}

// ---------- 工具列：資料夾膠囊與排序按鈕（同一行，高頻操作不用下拉） ----------

function chipLabel(name) {
  return name === "（根目錄）" ? "根目錄" : name;
}

function buildFolderChips() {
  els.folderChips.textContent = "";
  const names = ["", ...folders.map((f) => f.name)];
  for (const name of names) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip";
    btn.textContent = name === "" ? "全部" : chipLabel(name);
    btn.setAttribute("aria-pressed", String(prefs.folder === name));
    if (prefs.folder === name) btn.classList.add("active");
    btn.addEventListener("click", () => {
      prefs.folder = name;
      savePrefs();
      page = 1;
      refresh();
    });
    els.folderChips.appendChild(btn);
  }
}

function syncSortButtons() {
  els.sortName.classList.toggle("active", prefs.sortKey === "name");
  els.sortTime.classList.toggle("active", prefs.sortKey === "time");
  els.sortName.setAttribute("aria-pressed", String(prefs.sortKey === "name"));
  els.sortTime.setAttribute("aria-pressed", String(prefs.sortKey === "time"));
  els.sortDir.textContent = prefs.sortDir === "asc" ? "正序 ↑" : "反序 ↓";
}

function setSort(key) {
  prefs.sortKey = key;
  savePrefs();
  page = 1;
  refresh();
}
els.sortName.addEventListener("click", () => setSort("name"));
els.sortTime.addEventListener("click", () => setSort("time"));
els.sortDir.addEventListener("click", () => {
  prefs.sortDir = prefs.sortDir === "asc" ? "desc" : "asc";
  savePrefs();
  page = 1;
  refresh();
});

// ---------- 篩選＋排序＋分頁＋渲染 ----------

function visibleItems() {
  let list = prefs.folder === ""
    ? allItems.slice()
    : allItems.filter((i) => i.folder === prefs.folder);
  const dir = prefs.sortDir === "asc" ? 1 : -1;
  list.sort((a, b) => {
    if (prefs.sortKey === "name") {
      return a.name.localeCompare(b.name, "zh-Hant", { numeric: true, sensitivity: "base" }) * dir;
    }
    // 拍攝時間（captured）ISO 字串的字典序等同時間序；缺失時回退 mtime
    const ta = a.captured || a.mtime;
    const tb = b.captured || b.mtime;
    if (ta !== tb) return (ta < tb ? -1 : 1) * dir;
    return a.path.localeCompare(b.path, "zh-Hant", { numeric: true }) * dir;
  });
  return list;
}

function refresh() {
  buildFolderChips();
  syncSortButtons();
  items = visibleItems();
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  if (page > totalPages) page = totalPages;
  pageItems = items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  render(pageItems);
  renderPager(totalPages);
  renderFooter();
}

function renderCard(img, flatIndex) {
  const card = document.createElement("figure");
  card.className = "card" + (img.hidden ? " dim" : "");
  card.title = img.name || img.path;

  const el = document.createElement("img");
  el.loading = "lazy";
  el.decoding = "async";
  el.src = thumbUrl(img.path);
  el.alt = img.name || "";
  // 縮略圖生成失敗時回退原圖
  el.addEventListener("error", () => {
    if (!el.dataset.fallback) { el.dataset.fallback = "1"; el.src = mediaUrl(img.path); }
  }, { once: true });
  card.appendChild(el);

  if (display.date) {
    const badge = document.createElement("span");
    badge.className = "card-date";
    badge.textContent = (img.captured || img.mtime || "").slice(0, 10);
    card.appendChild(badge);
  }
  if (img.hidden) {
    const tag = document.createElement("span");
    tag.className = "card-hidden-tag";
    tag.textContent = "已隱藏";
    card.appendChild(tag);
  }

  const cap = document.createElement("figcaption");
  cap.textContent = img.name || img.path;
  if (!display.name) cap.hidden = true; // 仍保留於 DOM 供無障礙讀取
  card.appendChild(cap);

  if (isAdmin) {
    const actions = document.createElement("div");
    actions.className = "card-actions";

    const hideBtn = document.createElement("button");
    hideBtn.type = "button";
    hideBtn.className = "card-btn";
    hideBtn.textContent = img.hidden ? "顯示" : "隱藏";
    hideBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleHide(img, hideBtn);
    });
    actions.appendChild(hideBtn);

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "card-btn card-btn-del";
    delBtn.textContent = "刪除";
    let armed = false;
    let armTimer = 0;
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!armed) {
        armed = true;
        delBtn.textContent = "確定刪除？";
        delBtn.classList.add("armed");
        armTimer = setTimeout(() => {
          armed = false;
          delBtn.textContent = "刪除";
          delBtn.classList.remove("armed");
        }, 3000);
        return;
      }
      clearTimeout(armTimer);
      deletePhoto(img, card);
    });
    actions.appendChild(delBtn);
    card.appendChild(actions);
  }

  card.addEventListener("click", () => openLightbox(flatIndex));
  return card;
}

function render(list) {
  els.gallery.textContent = "";

  if (list.length === 0) {
    setStatus(allItems.length === 0 ? "圖庫暫時沒有圖片" : "此資料夾暫時沒有圖片", "ok");
    els.gallery.hidden = true;
    return;
  }
  setStatus("");
  els.gallery.hidden = false;

  const grid = document.createElement("div");
  grid.className = "grid";
  for (let flatIndex = 0; flatIndex < list.length; flatIndex++) {
    grid.appendChild(renderCard(list[flatIndex], flatIndex));
  }
  els.gallery.appendChild(grid);
}

// ---------- 分頁 ----------

function renderPager(totalPages) {
  els.pager.textContent = "";
  if (totalPages <= 1) {
    els.pager.hidden = true;
    return;
  }
  els.pager.hidden = false;

  const mkBtn = (label, target, disabled, active) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pager-btn" + (active ? " active" : "");
    btn.textContent = label;
    if (disabled) btn.disabled = true;
    else btn.addEventListener("click", () => {
      page = target;
      refresh();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    return btn;
  };

  els.pager.appendChild(mkBtn("‹ 上頁", page - 1, page === 1, false));
  // 頁碼窗口：首頁、末頁、當前頁 ±2，空位以省略號填補
  const shown = new Set([1, totalPages, page, page - 1, page + 1, page - 2, page + 2]);
  const nums = [...shown].filter((n) => n >= 1 && n <= totalPages).sort((a, b) => a - b);
  let prev = 0;
  for (const n of nums) {
    if (n - prev > 1) {
      const gap = document.createElement("span");
      gap.className = "pager-gap";
      gap.textContent = "…";
      els.pager.appendChild(gap);
    }
    els.pager.appendChild(mkBtn(String(n), n, false, n === page));
    prev = n;
  }
  els.pager.appendChild(mkBtn("下頁 ›", page + 1, page === totalPages, false));
}

// ---------- 頁腳：統計與管理入口 ----------

function renderFooter() {
  const year = (stats && stats.last_updated ? String(stats.last_updated).slice(0, 4) : "")
    || String(new Date().getFullYear());
  els.footSign.textContent = "Frankie Cheung · © " + year;

  const visibleTotal = allItems.filter((i) => !i.hidden).length;
  const parts = ["共 " + visibleTotal + " 張相"];
  if (stats && stats.last_updated) {
    parts.push("最後更新 " + String(stats.last_updated).replace("T", " ").slice(0, 16));
  }
  if (stats && Number.isFinite(stats.limit) && stats.limit > 0) {
    const pct = ((stats.used / stats.limit) * 100).toFixed(1);
    parts.push("儲存 " + fmtBytes(stats.used) + "／" + fmtBytes(stats.limit) + "（" + pct + "%）");
  }
  if (stats && Number.isFinite(stats.online)) {
    parts.push("在線 " + stats.online + " 人");
  }
  els.footStats.textContent = parts.join(" · ");
  els.footStats.hidden = false;

  const counts = new Map();
  for (const i of allItems) {
    if (!i.hidden) counts.set(i.folder, (counts.get(i.folder) || 0) + 1);
  }
  const segs = folders.map((f) => chipLabel(f.name) + "（" + (counts.get(f.name) || 0) + "）");
  els.footFolders.textContent = segs.join(" · ");
  els.footFolders.hidden = segs.length === 0;
}

// ---------- 管理端操作：隱藏／刪除 ----------

async function toggleHide(img, btn) {
  btn.disabled = true;
  try {
    const { status, data } = await api("/api/photo/hide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: img.key, hidden: !img.hidden }),
    });
    if (status === 200 && data && data.ok) {
      img.hidden = !img.hidden;
      refresh();
    } else {
      setStatus("操作失敗：" + detailOf(data, status), "err");
    }
  } catch (_) {
    setStatus("操作失敗：網絡錯誤", "err");
  } finally {
    btn.disabled = false;
  }
}

async function deletePhoto(img, card) {
  card.classList.add("removing");
  try {
    const { status, data } = await api("/api/photo/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: img.key }),
    });
    if (status === 200 && data && data.ok) {
      allItems = allItems.filter((i) => i !== img);
      folders = folders
        .map((f) => ({ ...f, count: f.images.filter((i) => i !== img).length,
                       images: f.images.filter((i) => i !== img) }))
        .filter((f) => f.count > 0);
      refresh();
    } else {
      card.classList.remove("removing");
      setStatus("刪除失敗：" + detailOf(data, status), "err");
    }
  } catch (_) {
    card.classList.remove("removing");
    setStatus("刪除失敗：網絡錯誤", "err");
  }
}

// ---------- Lightbox（範圍為當前頁） ----------

function openLightbox(index) {
  current = index;
  showCurrent();
  els.lightbox.hidden = false;
  document.body.style.overflow = "hidden"; // 開啟期間鎖定背景捲動
}

function closeLightbox() {
  els.lightbox.hidden = true;
  els.lbImg.removeAttribute("src");
  document.body.style.overflow = "";
  current = -1;
}

function showCurrent() {
  const item = pageItems[current];
  if (!item) return;
  els.lbImg.src = mediaUrl(item.path); // 大圖直接載入原圖
  els.lbImg.alt = item.name || "";
  els.lbName.textContent = item.name || item.path;
  const when = String(item.captured || item.mtime || "").replace("T", " ").slice(0, 16);
  els.lbIndex.textContent = (when ? when + " · " : "")
    + "第 " + (current + 1) + " / " + pageItems.length + " 張";
}

function step(delta) {
  if (current < 0 || pageItems.length === 0) return;
  current = (current + delta + pageItems.length) % pageItems.length; // 頁內循環
  showCurrent();
}

// 鍵盤：左右切換、Esc 關閉
document.addEventListener("keydown", (e) => {
  if (els.lightbox.hidden) return;
  if (e.key === "Escape") closeLightbox();
  else if (e.key === "ArrowLeft") step(-1);
  else if (e.key === "ArrowRight") step(1);
});

// 點擊背幕關閉（點在圖片或按鈕上不算背幕）
els.lightbox.addEventListener("click", (e) => {
  if (e.target === els.lightbox || e.target.classList.contains("lb-figure")) closeLightbox();
});

els.lbClose.addEventListener("click", closeLightbox);
els.lbPrev.addEventListener("click", (e) => { e.stopPropagation(); step(-1); });
els.lbNext.addEventListener("click", (e) => { e.stopPropagation(); step(1); });

// 手機左右滑動切換（橫向位移明顯大於縱向才觸發，避免誤判垂直捲動）
let touchX = 0;
let touchY = 0;
els.lightbox.addEventListener("touchstart", (e) => {
  if (e.touches.length !== 1) return;
  touchX = e.touches[0].clientX;
  touchY = e.touches[0].clientY;
}, { passive: true });

els.lightbox.addEventListener("touchend", (e) => {
  const t = e.changedTouches[0];
  const dx = t.clientX - touchX;
  const dy = t.clientY - touchY;
  if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) {
    step(dx < 0 ? 1 : -1);
  }
}, { passive: true });

// ---------- 查看密碼閘門（數字鍵盤） ----------

const CODE_MAX = 12;
let gateCode = "";
let gateBusy = false;

function renderGateDots() {
  els.gateDots.textContent = "";
  for (let i = 0; i < Math.max(gateCode.length, 4); i++) {
    const dot = document.createElement("span");
    dot.className = "dot" + (i < gateCode.length ? " on" : "");
    els.gateDots.appendChild(dot);
  }
}

function setGateMsg(text, kind) {
  els.gateMsg.textContent = text || "";
  els.gateMsg.className = "msg" + (kind ? " " + kind : "");
}

function openGate() {
  gateCode = "";
  renderGateDots();
  setGateMsg("請輸入查看密碼");
  setStatus("");
  els.toolbar.hidden = true;
  els.gallery.hidden = true;
  els.pager.hidden = true;
  els.gate.hidden = false;
}

function closeGate() {
  els.gate.hidden = true;
}

function buildPad() {
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "清空", "0", "⌫"];
  for (const key of keys) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pad-key" + (key.length > 1 ? " pad-fn" : "");
    btn.textContent = key;
    btn.addEventListener("click", () => pressKey(key));
    els.gatePad.appendChild(btn);
  }
  const ok = document.createElement("button");
  ok.type = "button";
  ok.className = "pad-key pad-ok";
  ok.textContent = "確定";
  ok.addEventListener("click", () => submitGate());
  els.gatePad.appendChild(ok);
}

function pressKey(key) {
  setGateMsg("");
  if (key === "清空") gateCode = "";
  else if (key === "⌫") gateCode = gateCode.slice(0, -1);
  else if (/^\d$/.test(key) && gateCode.length < CODE_MAX) gateCode += key;
  renderGateDots();
}

async function submitGate() {
  if (gateBusy) return;
  if (gateCode.length < 4) {
    setGateMsg("密碼至少 4 位數字", "err");
    return;
  }
  gateBusy = true;
  try {
    const { status, data } = await api("/api/view/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: gateCode }),
    });
    if (status === 200) {
      closeGate();
      await loadGallery();
    } else {
      setGateMsg(detailOf(data, status), "err");
      gateCode = "";
      renderGateDots();
    }
  } catch (_) {
    setGateMsg("網絡錯誤，請稍後重試", "err");
  } finally {
    gateBusy = false;
  }
}

// 桌面端鍵盤支援：數字、Backspace、Enter
document.addEventListener("keydown", (e) => {
  if (els.gate.hidden) return;
  if (/^\d$/.test(e.key)) pressKey(e.key);
  else if (e.key === "Backspace") pressKey("⌫");
  else if (e.key === "Enter") submitGate();
});

// ---------- 載入 ----------

async function loadGallery() {
  setStatus("載入中…");
  try {
    const { status, data } = await api("/api/gallery");
    if (status === 403) {
      openGate(); // 需查看密碼：顯示數字鍵盤
      return;
    }
    if (status !== 200 || !data) {
      setStatus("載入圖庫失敗：" + detailOf(data, status), "err");
      return;
    }
    els.title.textContent = data.title || "HKQuant Gallery";
    document.title = els.title.textContent;
    isAdmin = Boolean(data.is_admin);
    display = data.display || { date: true, name: true };
    stats = data.stats || null;

    folders = Array.isArray(data.folders) ? data.folders : [];
    allItems = [];
    for (const folder of folders) {
      for (const img of Array.isArray(folder.images) ? folder.images : []) {
        allItems.push({
          path: img.path,
          key: img.key || "",
          name: img.name || img.path,
          mtime: img.mtime || "",
          captured: img.captured || img.mtime || "",
          hidden: Boolean(img.hidden),
          folder: folder.name || "（根目錄）",
        });
      }
    }

    if (allItems.length === 0) {
      setStatus("圖庫暫時沒有圖片", "ok");
      renderFooter();
      return;
    }
    // 偏好中的資料夾若已不存在（被改名或移除），退回「全部」
    if (prefs.folder !== "" && !folders.some((f) => f.name === prefs.folder)) {
      prefs.folder = "";
      savePrefs();
    }
    page = 1;
    els.toolbar.hidden = false;
    refresh();
  } catch (_) {
    setStatus("載入圖庫失敗：網絡錯誤，請稍後重試", "err");
  }
}

buildPad();
loadGallery();
