"use strict";
// 圖庫首頁邏輯：讀取 /api/gallery 後按「設置頁全局配置」（資料夾可見性＋排序＋分頁）
// 展示相片與視頻：相片縮略圖走 /thumb（失敗回退 /media），視頻顯示可播放占位瓦片。
// 管理員登入狀態下每張卡片附「隱藏／刪除（二次確認）」按鈕（底部透明灰底、藍框／紅框）。
// 頁腳由 /footer.js 全域統一生成；本頁載入資料後經 FooterKit.apply 復用。
// 嚴格遵循 API 契約：fetch 一律 credentials:'same-origin'；path 未 encode，
// 拼 URL 時逐段 encodeURIComponent；錯誤提示直接顯示後端 detail。

const els = {
  title: document.getElementById("gallery-title"),
  status: document.getElementById("status"),
  gallery: document.getElementById("gallery"),
  pager: document.getElementById("pager"),
  lightbox: document.getElementById("lightbox"),
  lbImg: document.getElementById("lb-img"),
  lbVideo: document.getElementById("lb-video"),
  lbName: document.getElementById("lb-name"),
  lbIndex: document.getElementById("lb-index"),
  lbClose: document.getElementById("lb-close"),
  lbDl: document.getElementById("lb-download"),
  gate: document.getElementById("gate"),
  gateDots: document.getElementById("gate-dots"),
  gateMsg: document.getElementById("gate-msg"),
  gatePad: document.getElementById("gate-pad"),
  faceBtn: document.getElementById("face-btn"),
  faceModal: document.getElementById("face-modal"),
  faceFile: document.getElementById("face-file"),
  facePick: document.getElementById("face-pick"),
  faceGo: document.getElementById("face-go"),
  facePreview: document.getElementById("face-preview"),
  faceMsg: document.getElementById("face-msg"),
  faceClose: document.getElementById("face-close"),
  faceBanner: document.getElementById("face-banner"),
  faceBannerText: document.getElementById("face-banner-text"),
  faceReset: document.getElementById("face-reset"),
};

const PAGE_SIZE = 60;

// 全量媒體清單（扁平化，含所屬 folder、kind 與管理用 key/hidden）
let allItems = [];
let folders = [];      // 來自 API 的資料夾清單（含可見計數）
let items = [];        // 排序後清單（未分頁）
let pageItems = [];    // 當前頁可見清單（lightbox 序號來源）
let page = 1;
let isAdmin = false;
let display = { date: false, name: false, photos: true, videos: true };
let sortCfg = { by: "captured", desc: true }; // 全局排序（設置頁配置，服務端下發）
let stats = null;
let current = -1;
let facePaths = null;   // 人臉匹配的 path 集合（null＝無過濾）
let faceSavedPage = 1;  // 過濾前的頁碼，返回全部時還原
let faceBusy = false;
let faceFileSel = null;
let facePreviewUrl = "";

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

// 從後端回應取出可直接顯示的錯誤文字（契約格式 {"detail": "..."}，英文模式下映射常見訊息）
function detailOf(data, status) {
  if (data && typeof data.detail === "string" && data.detail) return I18N.detail(data.detail);
  return I18N.t("common.httpFail", { status });
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

// ---------- 視頻海報：瀏覽器端抽取第一格畫面（零後端負載；解碼不了的格式保留 ▶ 瓦片） ----------

const POSTER_MAX_SIDE = 640;
const POSTER_CONCURRENCY = 3;
const POSTER_TIMEOUT_MS = 12000;
let renderSeq = 0;        // 渲染代號：換頁/重渲染後丟棄舊任務
let posterQueue = [];
let posterActive = 0;

function queuePoster(seq, tile, item) {
  posterQueue.push({ seq, tile, item });
  pumpPosterQueue();
}

function pumpPosterQueue() {
  while (posterActive < POSTER_CONCURRENCY && posterQueue.length) {
    const job = posterQueue.shift();
    if (job.seq !== renderSeq || !document.contains(job.tile)) continue; // 已過期
    posterActive++;
    capturePoster(job.item, (dataUrl) => {
      posterActive--;
      if (dataUrl) job.item.poster = dataUrl; // 快喺 item 上，lightbox 開片時重用
      if (dataUrl && job.seq === renderSeq && document.contains(job.tile)) {
        const img = job.tile.querySelector(".video-poster");
        if (img) { img.src = dataUrl; img.hidden = false; }
      }
      pumpPosterQueue();
    });
  }
}

// 隱藏 <video> 解碼一幀 → canvas → dataURL（同源，無 canvas 污染問題）
function capturePoster(item, done) {
  let finished = false;
  const finish = (v) => { if (!finished) { finished = true; done(v); } };
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "metadata";
  video.playsInline = true;
  const timer = setTimeout(() => cleanup(null), POSTER_TIMEOUT_MS);
  function cleanup(result) {
    clearTimeout(timer);
    video.removeAttribute("src");
    video.load(); // 釋放解碼資源
    finish(result);
  }
  function draw() {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) { cleanup(null); return; }
    const scale = Math.min(1, POSTER_MAX_SIDE / Math.max(vw, vh));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(vw * scale));
    canvas.height = Math.max(1, Math.round(vh * scale));
    try {
      canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
      cleanup(canvas.toDataURL("image/jpeg", 0.72));
    } catch (_) {
      cleanup(null); // 個別編碼限制下 toDataURL 可能拋錯
    }
  }
  video.addEventListener("error", () => cleanup(null), { once: true });
  video.addEventListener("loadeddata", () => {
    // 抽開首一小段作靜幀（部分視頻首格偏黑）；極短片直接用第一格
    const d = Number.isFinite(video.duration) ? video.duration : 0;
    const target = d > 0.4 ? Math.min(1, d * 0.25) : 0;
    if (target > 0) {
      video.addEventListener("seeked", draw, { once: true });
      try { video.currentTime = target; } catch (_) { draw(); }
    } else {
      draw();
    }
  }, { once: true });
  video.src = mediaUrl(item.path);
  video.load();
}

// ---------- 排序＋分頁＋渲染（資料夾可見性與排序方式均由設置頁全局配置） ----------

function sortedItems() {
  const list = allItems.slice();
  const dir = sortCfg.desc ? -1 : 1;
  list.sort((a, b) => {
    if (sortCfg.by === "name") {
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

// 頁碼記憶：由設置頁／管理頁返回時還原之前睇開嘅頁（越界由 totalPages clamp）
const PAGE_KEY = "gallery.page";

function refresh() {
  items = sortedItems();
  // 人臉匹配過濾（僅本瀏覽器顯示層；不影響任何全局設置）
  if (facePaths) items = items.filter((i) => facePaths.has(i.path));
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  if (page > totalPages) page = totalPages;
  if (page < 1) page = 1;
  try { sessionStorage.setItem(PAGE_KEY, String(page)); } catch (_) { /* 隱私模式容忍 */ }
  pageItems = items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  render(pageItems);
  renderPager(totalPages);
}

function renderCard(img, flatIndex) {
  const card = document.createElement("figure");
  card.className = "card" + (img.hidden ? " dim" : "") + (img.kind === "video" ? " card-video" : "");
  card.title = img.name || img.path;

  if (img.kind === "video") {
    // 視頻卡：黑底播放瓦片＋瀏覽器端抽取的第一格海報（服務端不解碼視頻），
    // 瀏覽器無法解碼的格式自動保留 ▶ 瓦片；點擊開啟內嵌播放器
    const tile = document.createElement("div");
    tile.className = "video-tile";
    tile.setAttribute("role", "img");
    tile.setAttribute("aria-label", I18N.t("index.videoPrefix") + (img.name || img.path));
    const poster = document.createElement("img");
    poster.className = "video-poster";
    poster.alt = "";
    poster.hidden = true;
    tile.appendChild(poster);
    const icon = document.createElement("span");
    icon.className = "video-icon";
    icon.textContent = "▶";
    tile.appendChild(icon);
    card.appendChild(tile);
    queuePoster(renderSeq, tile, img);
  } else {
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
  }

  if (img.hidden) {
    const tag = document.createElement("span");
    tag.className = "card-hidden-tag";
    tag.textContent = I18N.t("index.hidden");
    card.appendChild(tag);
  }

  // 拍攝日期（含時分）與檔名同處圖片下方，分兩行水平置中，互不重疊
  const cap = document.createElement("figcaption");
  if (display.date) {
    const d = document.createElement("span");
    d.className = "card-date";
    d.textContent = (img.captured || img.mtime || "").slice(0, 16).replace("T", " ");
    cap.appendChild(d);
  }
  if (display.name) {
    const n = document.createElement("span");
    n.className = "card-name";
    n.textContent = img.name || img.path;
    cap.appendChild(n);
  }
  cap.hidden = !(display.date || display.name);
  card.appendChild(cap);

  if (isAdmin) {
    card.classList.add("has-actions");
    const actions = document.createElement("div");
    actions.className = "card-actions";

    const hideBtn = document.createElement("button");
    hideBtn.type = "button";
    hideBtn.className = "card-btn";
    hideBtn.textContent = img.hidden ? I18N.t("index.show") : I18N.t("index.hide");
    hideBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleHide(img, hideBtn);
    });
    actions.appendChild(hideBtn);

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "card-btn card-btn-del";
    delBtn.textContent = I18N.t("index.del");
    let armed = false;
    let armTimer = 0;
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!armed) {
        armed = true;
        delBtn.textContent = I18N.t("index.confirmDel");
        delBtn.classList.add("armed");
        armTimer = setTimeout(() => {
          armed = false;
          delBtn.textContent = I18N.t("index.del");
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
  // 令舊的視頻海報任務全部過期（異步回調不再寫入已替換的 DOM）
  renderSeq++;
  posterQueue = [];

  if (list.length === 0) {
    setStatus(I18N.t("index.empty"), "ok");
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

  els.pager.appendChild(mkBtn(I18N.t("index.prev"), page - 1, page === 1, false));
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
  els.pager.appendChild(mkBtn(I18N.t("index.next"), page + 1, page === totalPages, false));
}

// ---------- 頁腳：委托 /footer.js 全域渲染，本页有資料時直接喂入 ----------

function updateFooter() {
  if (window.FooterKit) {
    FooterKit.apply({ stats, folders, is_admin: isAdmin });
  }
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
      updateFooter();
    } else {
      setStatus(I18N.t("common.opFail") + detailOf(data, status), "err");
    }
  } catch (_) {
    setStatus(I18N.t("common.opFail") + I18N.t("common.networkErr"), "err");
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
      if (window.FooterKit) FooterKit.refresh(); // 張數／儲存已變，向服務端重取
    } else {
      card.classList.remove("removing");
      setStatus(I18N.t("common.delFail") + detailOf(data, status), "err");
    }
  } catch (_) {
    card.classList.remove("removing");
    setStatus(I18N.t("common.delFail") + I18N.t("common.networkErr"), "err");
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
  els.lbVideo.pause();
  els.lbVideo.removeAttribute("src");
  els.lbVideo.load(); // 釋放解碼資源
  els.lbVideo.hidden = true;
  els.lbImg.hidden = false;
  els.lbDl.hidden = true;
  document.body.style.overflow = "";
  current = -1;
}

function showCurrent() {
  const item = pageItems[current];
  if (!item) return;
  if (item.kind === "video") {
    // 視頻：用原生 <video controls> 播放原檔；點擊不翻頁（留給控件）
    els.lbImg.hidden = true;
    els.lbImg.removeAttribute("src");
    els.lbVideo.hidden = false;
    els.lbVideo.src = mediaUrl(item.path);
  } else {
    els.lbVideo.pause();
    els.lbVideo.removeAttribute("src");
    els.lbVideo.load();
    els.lbVideo.hidden = true;
    els.lbImg.hidden = false;
    els.lbImg.src = mediaUrl(item.path); // 大圖直接載入原圖
    els.lbImg.alt = item.name || "";
  }
  els.lbName.textContent = item.name || item.path;
  // 下載按鈕：同檔原圖／原視頻，download 屬性保留原檔名
  els.lbDl.href = mediaUrl(item.path);
  els.lbDl.setAttribute("download", item.name || "");
  els.lbDl.hidden = false;
  const when = String(item.captured || item.mtime || "").replace("T", " ").slice(0, 16);
  els.lbIndex.textContent = (when ? when + " · " : "")
    + (item.kind === "video" ? I18N.t("index.videoWord") + " · " : "")
    + I18N.t("index.itemOf", { n: current + 1, total: pageItems.length });
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

// 點擊背幕關閉（點在媒體或按鈕上不算背幕）
els.lightbox.addEventListener("click", (e) => {
  if (e.target === els.lightbox || e.target.classList.contains("lb-figure")) closeLightbox();
});

els.lbClose.addEventListener("click", closeLightbox);

// 圖片時左右半區翻頁：左 50%＝上一張、右 50%＝下一張（視頻時不攔截，留給播放控件）
els.lbImg.addEventListener("click", (e) => {
  e.stopPropagation();
  const rect = els.lbImg.getBoundingClientRect();
  step(e.clientX - rect.left < rect.width / 2 ? -1 : 1);
});

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

// ---------- 人臉搜尋（自拍找人：服務端 ONNX 比對，客戶端只做顯示過濾） ----------

function setFaceMsg(text, kind) {
  els.faceMsg.textContent = text || "";
  els.faceMsg.className = "msg" + (kind ? " " + kind : "");
}

function updateFaceBanner() {
  if (!facePaths) { els.faceBanner.hidden = true; return; }
  els.faceBannerText.textContent = I18N.t("face.matched", { n: facePaths.size });
  els.faceBanner.hidden = false;
}

function applyFaceFilter(paths) {
  if (paths && !facePaths) faceSavedPage = page; // 進入過濾前記頁碼
  if (!paths) page = faceSavedPage;              // 返回全部時還原
  facePaths = paths;
  updateFaceBanner();
  refresh();
}

els.faceBtn.addEventListener("click", () => {
  setFaceMsg("");
  els.faceModal.hidden = false;
});

els.faceClose.addEventListener("click", () => { els.faceModal.hidden = true; });

// 點背幕關閉（點在卡片內不算）
els.faceModal.addEventListener("click", (e) => {
  if (e.target === els.faceModal) els.faceModal.hidden = true;
});

els.facePick.addEventListener("click", () => els.faceFile.click());

els.faceFile.addEventListener("change", () => {
  const file = els.faceFile.files && els.faceFile.files[0];
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) { // 後端同上限（GALLERY_FACES_MAX_UPLOAD），前端先擋
    setFaceMsg(I18N.t("face.tooBig"), "err");
    els.faceFile.value = "";
    return;
  }
  faceFileSel = file;
  if (facePreviewUrl) URL.revokeObjectURL(facePreviewUrl);
  facePreviewUrl = URL.createObjectURL(file);
  els.facePreview.src = facePreviewUrl;
  els.facePreview.hidden = false;
  els.faceGo.disabled = false;
  setFaceMsg("");
});

els.faceGo.addEventListener("click", async () => {
  if (faceBusy) return;
  if (!faceFileSel) { setFaceMsg(I18N.t("face.needFirst"), "err"); return; }
  faceBusy = true;
  els.faceGo.disabled = true;
  setFaceMsg(I18N.t("face.searching"));
  try {
    // 契約：請求體＝圖片二進制（非 multipart）
    const res = await fetch("/api/face/search", {
      method: "POST", credentials: "same-origin", body: faceFileSel,
    });
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    if (res.status === 200 && data) {
      const matches = Array.isArray(data.matches) ? data.matches : [];
      if (matches.length === 0) {
        setFaceMsg(I18N.t("face.none"), "ok"); // 保持原清單，方便換一張再搜
        return;
      }
      applyFaceFilter(new Set(matches.map((m) => m.path)));
      els.faceModal.hidden = true;
    } else {
      setFaceMsg(detailOf(data, res.status), "err"); // 冇面／未啟用等 detail 直顯
    }
  } catch (_) {
    setFaceMsg(I18N.t("common.netRetry"), "err");
  } finally {
    faceBusy = false;
    els.faceGo.disabled = !faceFileSel;
  }
});

els.faceReset.addEventListener("click", () => applyFaceFilter(null));

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
  setGateMsg(I18N.t("gate.prompt"));
  setStatus("");
  els.gallery.hidden = true;
  els.pager.hidden = true;
  els.gate.hidden = false;
}

function closeGate() {
  els.gate.hidden = true;
}

// 數字鍵盤：功能鍵以內部代號（clear/back）處理，顯示文字隨語言渲染
function buildPad() {
  els.gatePad.textContent = "";
  const keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "back"];
  for (const key of keys) {
    const btn = document.createElement("button");
    btn.type = "button";
    const label = key === "clear" ? I18N.t("gate.clear") : key === "back" ? "⌫" : key;
    btn.className = "pad-key" + (key === "clear" || key === "back" ? " pad-fn" : "");
    btn.textContent = label;
    btn.addEventListener("click", () => pressKey(key));
    els.gatePad.appendChild(btn);
  }
  const ok = document.createElement("button");
  ok.type = "button";
  ok.className = "pad-key pad-ok";
  ok.textContent = I18N.t("gate.ok");
  ok.addEventListener("click", () => submitGate());
  els.gatePad.appendChild(ok);
}

function pressKey(key) {
  setGateMsg("");
  if (key === "clear") gateCode = "";
  else if (key === "back") gateCode = gateCode.slice(0, -1);
  else if (/^\d$/.test(key) && gateCode.length < CODE_MAX) gateCode += key;
  renderGateDots();
}

async function submitGate() {
  if (gateBusy) return;
  if (gateCode.length < 4) {
    setGateMsg(I18N.t("gate.short"), "err");
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
    setGateMsg(I18N.t("common.netRetry"), "err");
  } finally {
    gateBusy = false;
  }
}

// 桌面端鍵盤支援：數字、Backspace、Enter
document.addEventListener("keydown", (e) => {
  if (els.gate.hidden) return;
  if (/^\d$/.test(e.key)) pressKey(e.key);
  else if (e.key === "Backspace") pressKey("back");
  else if (e.key === "Enter") submitGate();
});

// ---------- 載入 ----------

async function loadGallery() {
  setStatus(I18N.t("index.loading"));
  try {
    const { status, data } = await api("/api/gallery");
    if (status === 403) {
      openGate(); // 需查看密碼：顯示數字鍵盤
      return;
    }
    if (status !== 200 || !data) {
      setStatus(I18N.t("index.loadFail") + detailOf(data, status), "err");
      return;
    }
    els.title.textContent = data.title || "HKQuant Gallery";
    document.title = els.title.textContent;
    isAdmin = Boolean(data.is_admin);
    display = data.display || { date: false, name: false, photos: true, videos: true };
    sortCfg = data.sort || { by: "captured", desc: true }; // 全局排序自設置頁下發
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
          kind: img.kind === "video" ? "video" : "image",
          hidden: Boolean(img.hidden),
          folder: folder.name || "（根目錄）",
        });
      }
    }

    updateFooter(); // 頁腳全域組件復用本份資料
    if (allItems.length === 0) {
      setStatus(I18N.t("index.empty"), "ok");
      return;
    }
    const savedPage = parseInt(sessionStorage.getItem(PAGE_KEY) || "1", 10);
    page = Number.isFinite(savedPage) && savedPage > 0 ? savedPage : 1; // 返回時還原頁碼
    refresh();
  } catch (_) {
    setStatus(I18N.t("index.loadFail") + I18N.t("common.netRetry"), "err");
  }
}

// 語言切換（設置頁保存後同頁廣播；跨頁靠重新載入）：鍵盤與已渲染內容即時跟隨
document.addEventListener("i18n:lang", () => {
  buildPad();
  if (!els.gate.hidden) setGateMsg(I18N.t("gate.prompt"));
  if (stats) updateFooter();
  updateFaceBanner();
  if (items.length) refresh();
});

I18N.init().then(() => {
  buildPad();
  loadGallery();
});
