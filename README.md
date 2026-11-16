# hkquant-gallery — gallery.hkquant.com 圖庫服務

手機版優先的相簿網站：遞歸讀取 FTP 目錄展示相片與視頻（視頻可線上播放／下載），資料全部以 JSON 保存，
提供管理登入（改密碼、改圖庫資料夾、改主頁標題、隱藏／刪除照片）、查看密碼閘門、
縮略圖與分頁、在線人數與 FTP 容量顯示。

## 功能
- **首頁**（暗黑默認、#00e6a8）：**冇工具列**（資料夾可見性／排序／顯示全部移到「設置」頁
  全局配置，服務端下發 sort/display 後前端排序）；相片縮圖用 `/thumb`（lazy load＋img onerror
  回退原圖），**視頻卡＝黑底播放瓦片（▶ 圖標，不請求 /thumb；瀏覽器自行抽取第一格畫面作海報，
  解碼不了的格式維持 ▶ 瓦片）**；圖片下方兩行水平置中：
  拍攝日期「YYYY-MM-DD HH:MM」（EXIF DateTimeOriginal，無 EXIF 回退檔案修改時間）＋檔名
  （兩者受「設置」頁開關控制，**默認關閉**，互不重疊）；**分頁每頁 60 張**（切頁捲返頂，
  頁碼存 sessionStorage——由設置頁／管理頁返回時**還原之前所見頁**）；
  lightbox：**圖片時點左半＝上一張、右半＝下一張**，視頻用原生 `<video controls playsinline>`
  播放（點擊不翻頁）；左右鍵／手機橫滑、拍攝時間＋連續編號、Esc／背幕關閉，序號範圍＝當前頁）
- **FOOTER（全域組件 `/footer.js`）**：首頁／管理／設置三頁同款同步，掛 body 最底，
  60 秒自動刷新（由上至下）：總張數／最後更新（最新相拍攝時間）／在線人數（180 秒窗口去重）
  → 儲存用量（獨立一行）→ 各資料夾張數 →「Frankie Cheung · © 年份」→「管理」入口最底；
  未過查看閘門時靜默降級為署名＋管理按鈕
- **查看密碼閘門**（管理頁可啟用／停用）：啟用後訪客須輸入 4–12 位數字密碼
  （內置數字鍵盤，手機免彈系統鍵盤；桌面支援鍵盤輸入）；會話 30 天，
  管理員免輸入；改密碼即令所有查看會話失效；錯 5 次鎖 5 分鐘
- **管理頁 `/admin`**：純密碼登入（無用戶名），所有操作按鈕全寬、登出紅底白字；
  面板順序＝主頁標題（第一）、圖庫資料夾（相對 FTP 根的路徑，`.`＝根目錄）、FTP 儲存容量條
  （10G 配額，≥80% 轉紅）、查看密碼設置、修改密碼、**危險區域（一鍵全部刪除，
  管理密碼二次確認；只刪相片與視頻，RAW／文件等非媒體保留）**、登出
- **管理模式（首頁 is_admin）**：圖片底部疊一列「隱藏／顯示」＋「刪除」（平分寬度、
  透明深灰底、藍框／紅框；刪除再按一次＝確定；隱藏卡變暗＋徽標，公眾即時不可見）；
  `key`／`hidden` 欄位只對管理下發
- **雙語 UI（繁體中文／English）**：語言喺設置頁選擇後**保存在本瀏覽器 Cookie**
  （未設置時用服務器全局默認，`GET /api/lang` 已跟 Cookie），**默認繁體中文**；
  文案集中喺 `web/i18n.js`（`data-i18n` 靜態屬性＋JS `t()` 動態文字；
  後端常見錯誤訊息英文模式下自動翻譯）
- **設置頁 `/settings`（所有訪客可用，無需登入）**：①界面語言 ②主頁內容（顯示相片／顯示視頻）
  ③縮略圖資訊（拍攝日期／檔案名稱）④排序方式（時間／名稱＋正序／反序）——**個人設置，
  勾選即時自動保存至本瀏覽器 Cookie**（`GET/POST /api/prefs`），只影響自己；
  ⑤顯示資料夾（複選框，全選＝全部可見，空選自動還原）屬**全局設置，僅管理員登入後可見**；
  底部「返回主頁」按鈕（主頁還原頁碼）；管理頁登出後自動跳返主頁
- **數據全部 JSON**：`<數據目錄>/db/settings.json`（資料夾、標題、閘門開關、隱藏清單、
  顯示開關）、`db/auth.json`（scrypt 密碼散列×2、會話表、失敗鎖定）、
  `db/meta.json`（EXIF 拍攝時間增量快取，按大小|mtime 指紋）；損壞自動備份為
  `*.corrupt` 並按初始密碼重建
- **安全**：登入 5 次失敗鎖 5 分鐘；HttpOnly cookie 會話（管理 7 天滑動／查看 30 天）；
  `/media` 與 `/thumb` 防目錄穿越＋隱藏檔案封鎖＋媒體副檔白名單（圖片排除 svg；
  視頻 mp4/mov/webm/mkv/avi/flv 等 20 餘種，能否播放取決於瀏覽器原生解碼，
  MP4/H.264、WebM 通用性最好）；媒體操作路徑嚴格校驗（拒絕絕對路徑／`..`／非媒體）

## 部署（伺服器 47.82.97.159）
容器 `hkquant-gallery`（FastAPI + uvicorn 單進程，兼靜態頁面），
hkquant-net 靜態 IP `172.18.0.17:8000`，經 NPM（proxy host 10，證書 npm-9）
對外只提供 `https://gallery.hkquant.com`（ssl_forced）。
掛載：`/srv/ftp:/srv/ftp`（FTP 根，**可寫**——刪除照片功能需要，寫路徑僅經
`/api/photo/delete*`）、`/opt/hkquant-gallery/data:/data`。

```powershell
# 本地（repo 根目錄）
python scripts/pack_gallery_src.py
python ssh_run.py --upload hkquant-gallery-src.tar.gz
python ssh_run.py --upload .SCRATCH/gallery_env_min   # 僅首次需要（含 GALLERY_ADMIN_PASSWORD，'wb' 寫 LF，值含 # 需單引號）
python ssh_run.py --script scripts/stage_x2_gallery_deploy.sh
```

管理密碼：初始值在本地 `.env` 的 `GALLERY_ADMIN_PASSWORD`（只用於首次初始化
auth.json）；上線後以管理頁修改為準，伺服器有效值在 `/opt/hkquant-gallery/www/.env`
已不再參與驗證（auth.json 為準）。

## 本地開發（Windows）
```powershell
pip install -r requirements.txt
$env:GALLERY_FTP_ROOT="<測試圖片目錄>"; $env:GALLERY_DATA_DIR="data"; $env:GALLERY_COOKIE_SECURE="0"
python -m uvicorn app.main:app --port 8000 --app-dir hkquant-gallery
```
迴歸測試：`python -I .SCRATCH/gallery_e2e.py`（162 項，程序內 TestClient，
含 delete_all 清空測試——只用临时fixtures，唔會碰真實檔案）；
公網閘門實測：`python -I .SCRATCH/gallery_gate_check.py`（跑完自動復位）。

## API 摘要
公開：`GET /api/healthz`、`GET /api/gallery`（含 `is_admin`／`display` 四鍵／`sort`／`stats`，
條目含 `kind`＝image｜video；display／sort **訪客 Cookie 優先、未設回退全局**）、
`GET /media/{path}`（圖片／視頻）、
`GET /thumb/{path}`（視頻 404，前端用播放瓦片；受查看密碼閘門約束，啟用且未過閘 → 403）、
`GET /footer.js`（全站頁腳組件）、`GET /i18n.js`（雙語文案組件）、`GET /api/lang`（跟 Cookie）、
`GET/POST /api/prefs`（訪客顯示設置，寫 Cookie `gallery_prefs`=`lang|dddd|by.desc`）、
`GET /api/view/state`、`POST /api/view/login`
認證：`POST /api/login`、`POST /api/logout`、`GET /api/session`、
`GET /api/settings`（含 sort／lang／all_folders／visible_folders）、`GET /api/storage`、
`POST /api/settings/root|title|password|view|display|sort|folders|lang`、
`POST /api/photo/hide|delete|delete_all`
錯誤統一 `{"detail": "..."}`；細節見 `.SCRATCH/gallery_api_contract.md`。

## 環境變數（`.env`，參考 `.env.example`）
| 變數 | 說明 |
|---|---|
| GALLERY_ADMIN_PASSWORD | 初始管理密碼（僅首次初始化時生效） |
| GALLERY_TITLE | 默認主頁標題（管理頁可覆蓋） |
| GALLERY_FTP_ROOT | FTP 根目錄（默認 /srv/ftp） |
| GALLERY_DATA_DIR | JSON 數據目錄（默認 /data） |
| GALLERY_COOKIE_SECURE | 默認 1；本地 http 調試設 0 |
| GALLERY_MAX_IMAGES / GALLERY_LIST_TTL | 掃描上限／快取秒數 |
| GALLERY_QUOTA_BYTES | FTP 配額（字節，默認 10G），僅供容量顯示，須與主機 setquota 一致 |
| GALLERY_THUMB_MAX_SIDE / GALLERY_THUMB_QUALITY | 縮略圖最長邊／JPEG 質量（默認 640／80） |
