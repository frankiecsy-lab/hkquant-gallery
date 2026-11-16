"use strict";
// 全域共用頁腳（首頁／管理／設置同款同步）：統計、儲存、資料夾張數、管理入口、署名。
// 自動拉取 /api/gallery 渲染並每 60 秒刷新；首頁 app.js 已載入畫廊資料時可呼叫
// FooterKit.apply(data) 復用同一份資料，避免重複請求。
// 查看閘門啟用且未過閘時 /api/gallery 回 403，靜默降級為只顯示署名＋管理入口。

window.FooterKit = (function () {
  const REFRESH_MS = 60000;

  function fmtBytes(n) {
    if (!Number.isFinite(n) || n < 0) return "—";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)) + " " + units[i];
  }

  function chipLabel(name) { return name === "（根目錄）" ? I18N.t("footer.root") : name; }

  // 構建一次固定骨架（順序：統計行→儲存行→資料夾行→署名→管理按鈕最底）
  const footer = document.createElement("footer");
  footer.className = "footer";
  const statsLine = document.createElement("p");
  statsLine.className = "foot-line"; statsLine.hidden = true;
  const storageLine = document.createElement("p");
  storageLine.className = "foot-line"; storageLine.hidden = true;
  const foldersLine = document.createElement("p");
  foldersLine.className = "foot-line"; foldersLine.hidden = true;
  const adminLink = document.createElement("a");
  adminLink.className = "admin-link foot-admin";
  adminLink.href = "/admin"; adminLink.textContent = I18N.t("footer.admin");
  // 批量下載入口：僅主頁註冊回調（FooterKit.onDownload）且全站開關開放時顯示
  const dlBtn = document.createElement("button");
  dlBtn.type = "button";
  dlBtn.className = "foot-dl";
  dlBtn.textContent = I18N.t("footer.download");
  dlBtn.hidden = true;
  const sign = document.createElement("p");
  sign.className = "foot-sign";
  sign.textContent = "Frankie Cheung";
  const btnRow = document.createElement("p");
  btnRow.className = "foot-btns";
  btnRow.append(dlBtn, adminLink);
  footer.append(statsLine, storageLine, foldersLine, sign, btnRow);
  document.addEventListener("DOMContentLoaded", () => document.body.appendChild(footer));
  if (document.readyState !== "loading") document.body.appendChild(footer);

  let lastData = null; // 快取最近一次資料，語言切換時即時重渲染
  let onDownload = null; // 主頁註冊的下載模式回調；其他頁面保持 null＝不顯示下載鍵

  dlBtn.addEventListener("click", () => { if (onDownload) onDownload(); });

  function apply(data) {
    if (!data || !data.stats) { return; }
    lastData = data;
    const st = data.stats;

    // 公眾只計非隱藏；管理端資料含 hidden 條目，需排除
    let visibleTotal = Number.isFinite(st.total) ? st.total : 0;
    const flat = [];
    for (const f of Array.isArray(data.folders) ? data.folders : []) {
      for (const img of Array.isArray(f.images) ? f.images : []) {
        flat.push({ folder: f.name || "（根目錄）", hidden: Boolean(img.hidden) });
      }
    }
    const counts = new Map();
    for (const it of flat) {
      if (it.hidden) continue;
      counts.set(it.folder, (counts.get(it.folder) || 0) + 1);
    }

    const parts = [I18N.t("footer.stats", { n: visibleTotal })];
    if (st.last_updated) {
      parts.push(I18N.t("footer.updated",
        { t: String(st.last_updated).replace("T", " ").slice(0, 16) }));
    }
    if (Number.isFinite(st.online)) parts.push(I18N.t("footer.online", { n: st.online }));
    statsLine.textContent = parts.join(" · ");
    statsLine.hidden = false;

    if (Number.isFinite(st.limit) && st.limit > 0) {
      const pct = ((st.used / st.limit) * 100).toFixed(1);
      storageLine.textContent = I18N.t("footer.storage",
        { u: fmtBytes(st.used), l: fmtBytes(st.limit), p: pct });
      storageLine.hidden = false;
    } else {
      storageLine.hidden = true;
    }

    const names = (Array.isArray(data.folders) ? data.folders : []).map((f) => f.name);
    const segs = names.filter((n) => n).map((n) => chipLabel(n) + "（" + (counts.get(n) || 0) + "）");
    foldersLine.textContent = segs.join(" · ");
    foldersLine.hidden = segs.length === 0;

    const year = (st.last_updated ? String(st.last_updated).slice(0, 4) : "")
      || String(new Date().getFullYear());
    sign.textContent = "Frankie Cheung · © " + year;

    dlBtn.hidden = !(data.downloads && onDownload);
  }

  async function refresh() {
    try {
      const res = await fetch("/api/gallery", { credentials: "same-origin" });
      if (res.status === 200) apply(await res.json());
    } catch (_) { /* 靜默：保留署名骨架 */ }
  }

  // 語言切換：管理按鈕與最近一次統計即時重渲染
  document.addEventListener("i18n:lang", () => {
    adminLink.textContent = I18N.t("footer.admin");
    dlBtn.textContent = I18N.t("footer.download");
    if (lastData) apply(lastData);
  });

  refresh();
  setInterval(refresh, REFRESH_MS);

  return {
    apply,
    refresh,
    // 主頁註冊進入／退出下載選擇模式的回調；註冊時即時按最近資料決定按鍵可見性
    setOnDownload(fn) {
      onDownload = fn;
      dlBtn.hidden = !(lastData && lastData.downloads);
    },
  };
})();
