# FILE_MAP — hkquant-gallery

- `app/main.py` — FastAPI 路由總入口：公開 API（gallery/media/thumb/mid—視頻 thumb＝ffmpeg 抽幀 200 JPEG、mid 視頻 404、原圖僅 /media 供下載；gallery 嘅 display/sort 訪客 Cookie 優先回退全局＋downloads 欄位）、認證接口、查看密碼閘門（require_view）、在線 presence、容量統計、媒體隱藏/刪除（含一鍵全刪；刪除同步清縮圖＋中圖快取 `_purge_media_caches`）、批量下載（POST /api/download/zip 流式 ZIP＋上限＋併發訊號量，settings/downloads 開關）、訪客偏好端點（GET/POST /api/prefs，Cookie `lang|dddd|by.desc`）、全局設置端點（display 四鍵/sort/folders/lang/downloads）、人臉端點（POST /api/face/search 二進制體＋可視過濾、index/unload/auto/status 屬管理；定時索引 60s 心跳線程）、訪問統計端點（GET /api/stats、POST /api/stats/reset）、公開 /api/lang、緩存策略中間件（頁面 no-cache／媒體一年 immutable／API no-store）、首頁 GET ?password= 閘門直入、footer.js／i18n.js 服務、路徑安全校驗（防穿越/隱藏檔/媒體白名單/絕對路徑拒絕）、靜態頁面服務
- `app/faces.py` — 人臉搜尋核心（buffalo_sc ONNX）：SCRFD 手寫 anchor 解碼＋NMS＋5 點相似變換對齊＋512 維向量；惰性載入＋閒置看門狗卸載；`db/faces.json` 增量索引（size|mtime 指紋，base64 float32 向量）＋節流背景執行緒；餘弦比對；閒置卸載秒數運行期可覆蓋（set_idle_unload_seconds，管理頁）；缺模型拋 FaceUnavailable→503
- `app/statslog.py` — 訪問統計：UA 設備分類（手機 iOS/安卓/平板/桌面/機器人）＋瀏覽器標籤、按日匯總（60 日）＋最近 300 條事件環形緩衝、同訪客 5 分鐘節流、`stats.json` 原子寫入、snapshot/reset
- `app/vthumb.py` — 視頻縮略圖抽幀（imageio-ffmpeg 內建 ffmpeg，先 seek 1 秒後備 0 秒→PNG→Pillow JPEG；併發 2＋15 秒超時；失敗回 False→404 降級 ▶ 瓦片；POC 0.32s／73MB）
- `app/store.py` — JSON 數據層：settings/auth 原子讀寫、scrypt 密碼（管理＋查看）、會話表（管理/查看）、失敗鎖定、隱藏清單、顯示開關（date/name/photos/videos）、全局排序（sort_by/sort_desc）、可見資料夾（visible_folders，null＝全部）、界面語言（lang，默認 zh）、人臉閒置卸載分鐘（face_idle_minutes，-1＝跟 env）、人臉定時索引（face_auto_enabled/face_auto_minutes 5–1440）、批量下載開關（downloads_enabled，默認 False）、損壞備份
- `app/scanner.py` — 圖庫目錄遞歸掃描（IMAGE_EXTS＋VIDEO_EXTS→MEDIA_EXTS 白名單、跳隱藏檔、entry.kind 區分圖/視頻、分組、TTL 緩存、截斷上限）＋EXIF 拍攝時間與像素尺寸一次讀（entry 加 w/h 供灯箱顯示原圖分辨率；視頻取 mtime 無 w/h；meta.json 增量快取 v2 指紋、purge/prune）
- `app/config.py` — 環境變數配置（FTP 根、數據目錄、cookie/鎖定策略、配額字節數、縮略圖尺寸/質量、中圖 MID_MAX_SIDE/QUALITY/DIR、批量下載上限、在線窗口、人臉模型目錄/閾值/節流/閒置卸載/上傳上限、STATS_DB）
- `web/index.html` + `web/app.js` — 首頁：冇工具列（排序/篩選由設置下發）、縮圖網格（/thumb＋figcaption 日期/檔名置中＋視頻海報＝伺服器 /thumb 抽幀優先、瀏覽器端抽取後備＋分頁每頁 60，頁碼存 sessionStorage 返回還原）、lightbox（**全量跨頁**：序號以篩選結果計、越界自動切頁；圖片先顯示已快取縮圖再換 /mid 中圖（lbToken 作廢過期預載；媒體 URL 一律帶 ?v=檔案指紋配一年長緩存）、三行說明＝檔名/原圖分辨率（entry w/h）/時間＋項數；圖片左右半區點擊＋圖片/視頻統一常顯且錨定 .lb-media 媒體邊緣的加大版 ‹ › 翻頁圓鍵＋⬇ 下載（原圖）＋原生 video 播放，鍵盤/橫滑）、批量下載選擇模式（卡片勾選＋橫幅 已選/全選/下載 ZIP/退出，跨頁保留；隱藏 form＋iframe 原生下載＋錯誤讀回）、管理模式卡片隱藏/刪除按鈕（透明深灰底藍/紅框，錨定 .card-media 媒體層）、查看密碼數字鍵盤閘卡、人臉搜尋（頂欄掣＋自拍卡 capture=user＋匹配橫幅返回全部＋顯示層過濾，還原過濾前頁碼）
- `web/i18n.js` — 雙語文案組件（window.I18N，繁中／英文）：字典＋t()/detail()＋data-i18n 渲染＋"i18n:lang" 廣播；語言由設置頁全局配置（默認繁中）
- `web/footer.js` — 全域頁腳組件（window.FooterKit）：統計/儲存/資料夾張數/管理入口/署名，首頁／管理／設置三頁掛 body 最底，60 秒自動刷新，403 靜默降級；「下載」鍵僅批量下載開放且主頁註冊回調（setOnDownload）時顯示
- `web/settings.html` + `web/settings.js` — 顯示設置頁（所有訪客，四面板 Cookie 自動保存）：界面語言（繁中/英文）、主頁內容（相片/視頻）、縮略圖資訊（日期/檔名）、排序方式（radio）；第五面板「顯示資料夾」屬全局僅管理員可見；底部返回主頁按鈕
- `web/admin.html` + `web/admin.js` — 管理頁：登入；**Tab 分類＝常規／人臉／下載與統計／危險**（sessionStorage 記住）；常規＝主頁標題第一、圖庫資料夾、FTP 容量條、查看密碼、修改密碼；人臉＝索引狀態＋建立/重建＋閒置卸載分鐘＋定時索引開關/間隔（5–1440）＋索引中 4 秒輪詢；下載與統計＝批量下載開關＋訪問統計（14 日設備分類表/瀏覽器分佈/最近事件/重置二次確認）；危險＝一鍵全刪＋密碼二次確認、登出；按鈕全寬，登出紅底白字；動態文字隨 i18n:lang 重渲染
- `web/style.css` — 全站共用暗黑主題（#00e6a8）、分頁/卡片按鈕/容量條/閘卡樣式、響應式/手機微調
- `Dockerfile` / `docker-compose.yml` — 生產鏡像與編排（靜態 IP 172.18.0.17、/srv/ftp 可寫掛載——刪除功能需要、/models 只讀掛載——人臉模型）
- `requirements.txt` — 運行依賴（fastapi、uvicorn、pillow、onnxruntime、numpy、zipstream-ng、imageio-ffmpeg）
- `.env.example` — 環境變數模板（真實 .env 嚴禁入庫）
