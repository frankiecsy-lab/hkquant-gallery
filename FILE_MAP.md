# FILE_MAP — hkquant-gallery

- `app/main.py` — FastAPI 路由總入口：公開 API（gallery/media/thumb—視頻 media 直出、thumb 404）、認證接口、查看密碼閘門（require_view）、在線 presence、容量統計、媒體隱藏/刪除（含一鍵全刪相片＋視頻）、全局設置端點（display 四鍵/sort/folders/lang）、公開 /api/lang、footer.js／i18n.js 服務、路徑安全校驗（防穿越/隱藏檔/媒體白名單/絕對路徑拒絕）、靜態頁面服務
- `app/store.py` — JSON 數據層：settings/auth 原子讀寫、scrypt 密碼（管理＋查看）、會話表（管理/查看）、失敗鎖定、隱藏清單、顯示開關（date/name/photos/videos）、全局排序（sort_by/sort_desc）、可見資料夾（visible_folders，null＝全部）、界面語言（lang，默認 zh）、損壞備份
- `app/scanner.py` — 圖庫目錄遞歸掃描（IMAGE_EXTS＋VIDEO_EXTS→MEDIA_EXTS 白名單、跳隱藏檔、entry.kind 區分圖/視頻、分組、TTL 緩存、截斷上限）＋EXIF 拍攝時間提取（視頻取 mtime；meta.json 增量快取、purge/prune）
- `app/config.py` — 環境變數配置（FTP 根、數據目錄、cookie/鎖定策略、配額字節數、縮略圖尺寸/質量、在線窗口）
- `web/index.html` + `web/app.js` — 首頁：冇工具列（排序/篩選由全局設置下發）、縮圖網格（/thumb＋figcaption 日期/檔名置中＋視頻 ▶ 瓦片＋分頁每頁 60）、lightbox（圖片左右半區翻頁＋⬇ 下載＋原生 video 播放，鍵盤/觸控，限當前頁）、管理模式卡片隱藏/刪除按鈕（透明灰底藍/紅框）、查看密碼數字鍵盤閘卡
- `web/i18n.js` — 雙語文案組件（window.I18N，繁中／英文）：字典＋t()/detail()＋data-i18n 渲染＋"i18n:lang" 廣播；語言由設置頁全局配置（默認繁中）
- `web/footer.js` — 全域頁腳組件（window.FooterKit）：統計/儲存/資料夾張數/管理入口/署名，首頁／管理／設置三頁掛 body 最底，60 秒自動刷新，403 靜默降級
- `web/settings.html` + `web/settings.js` — 全局設置頁（僅管理員，五面板自動保存）：界面語言（繁中/英文）、主頁內容（相片/視頻）、縮略圖資訊（日期/檔名）、排序方式（radio）、顯示資料夾（checkbox）
- `web/admin.html` + `web/admin.js` — 管理頁：登入、面板（主頁標題第一、圖庫資料夾、FTP 容量條、查看密碼、修改密碼、危險區域一鍵全刪＋密碼二次確認、登出；按鈕全寬，登出紅底白字）；動態文字隨 i18n:lang 重渲染
- `web/style.css` — 全站共用暗黑主題（#00e6a8）、分頁/卡片按鈕/容量條/閘卡樣式、響應式/手機微調
- `Dockerfile` / `docker-compose.yml` — 生產鏡像與編排（靜態 IP 172.18.0.17、/srv/ftp 可寫掛載——刪除功能需要）
- `requirements.txt` — 運行依賴（fastapi、uvicorn、pillow）
- `.env.example` — 環境變數模板（真實 .env 嚴禁入庫）
