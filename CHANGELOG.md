# Changelog — hkquant-gallery

## v1.6.1（2026-11-16 同日修補，已部署＋公網全綠）
- **修復：視頻→圖片切換顯示錯誤**——漸進顯示重構時弄丟 `els.lbVideo.hidden = true`，播放器未收起，
  與圖片在 `.lb-media` flex 下並排（用戶截圖反映）；已補回並加防回歸斷言（公網驗證斷言 app.js 出現次數 ≥2）
- **翻頁 ‹ › 真正垂直置中**——文字字模受字體基線影響視覺偏上；改偽元素邊框繪製幾何箭嘴
  （尺寸／粗細隨 font-size 縮放、顏色跟 currentColor、旋轉後補償 0.35 邊長水平偏移）
- **「批量下載」開關升級為全站下載許可**（用戶要求）：控制放大圖（圖片／視頻）⬇ 下載鍵＋主頁 ZIP 入口——
  關閉時全站下載按鈕收起（視頻在線播放不受影響）；管理面板標題／提示同步改語義（繁英）

## v1.6.0（2026-11-16）
- **批量下載（ZIP 流式打包）**：管理頁可全站開關（默認關閉）；開啟後 footer「管理」左邊出現「下載」鍵
  → 卡片右上角勾選＋橫幅（已選 N／全選／下載 ZIP／退出，跨頁保留勾選）；
  `POST /api/download/zip`（require_view）用 zipstream-ng 流式輸出（ZIP_STORED，媒體本身已壓縮），
  伺服器零記憶體峰值；自動剔除請求者不可見的檔案（隱藏／不可見資料夾），ZIP 內容＝可見集；
  單次上限 500 檔／2GB（`GALLERY_DOWNLOAD_MAX_FILES/MAX_BYTES`）、併發 2（超出 429）；
  前端隱藏 form＋iframe 觸發瀏覽器原生下載（大檔唔會爆瀏覽器記憶體），錯誤由 iframe 同源讀回顯示
- **灯箱跨頁全量瀏覽＋三行說明**：‹ ›／鍵盤以當前篩選結果全量計數（79 張每頁 60 都可睇晒全部），
  越過頁界背景網格自動跟隨；下方分行顯示 檔名／**原圖分辨率**／時間＋第 N／共 M 項
- **中圖層 `/mid/{path}`（加速顯示）**：灯箱不再載入原圖，改載 1600px 中圖
  （`GALLERY_MID_MAX_SIDE/QUALITY`，快取 `/data/mids`）；前端先用已快取縮圖秒開、中圖就緒才換上
  （lbToken 作廢過期預載）；分辨率由掃描期讀取的 entry `w/h` 即刻顯示（scanner 指紋升 v2，
  EXIF 與像素尺寸一次讀）；**原圖僅經 `/media` 用於單張下載與 ZIP**；
  快取檔名帶相對路徑哈希前綴——刪除單張同步清走縮圖＋中圖兩層，一鍵刪除清空兩層
- **視頻縮略圖改伺服器端抽幀**：`app/vthumb.py`（imageio-ffmpeg 內建 ffmpeg，先 seek 1 秒後備 0 秒，
  semaphore 併發 2＋15 秒超時，失敗 404 保留 ▶ 瓦片）；POC 實測 6.3MB MP4 抽幀 0.32 秒／子進程
  peak RSS 73MB（一次性容器 512m），1.6G 共享伺服器 Safe；瀏覽器端抽取降為後備（服務端已生成嘅
  海報唔會再被覆蓋）；`/thumb` 視頻由 404 改回 200 JPEG；順手修 vthumb 首次部署快取目錄未建立的 bug
- **人臉定時索引**：管理頁可開關＋設間隔 5–1440 分鐘（`POST /api/face/auto`，持久化，
  後台 60 秒心跳調度，只喺模型就緒且有新圖待索引時觸發）；`GET /api/face/status` 加 `auto_index` 欄位
- **自拍搜尋命中率**：偵測閾值 DET_THRESH 0.5→0.42（誤偵仍由餘弦 0.40 把關）＋搜尋事件日誌
  （bytes/faces/admin）；公網實驗證明同一組 bytes 匿名／管理結果一致，admin 搜唔到屬自拍本身的偵測臨界問題
- **訪問統計**：`app/statslog.py`——按 UA 分類（手機 iOS／安卓／平板／桌面／機器人）＋瀏覽器標籤，
  按日匯總＋最近 300 條事件（時間＋設備＋路徑）；記錄點＝/api/gallery（footer 三頁齊拍），
  同一訪客 5 分鐘節流防 60 秒自動刷新灌水；`GET /api/stats`＋`POST /api/stats/reset`（管理，可重置）；
  管理頁「訪問統計」面板（14 日表＋設備分佈＋最近事件＋重置二次確認）
- **管理頁 Tab 分類**：常規／人臉／下載與統計／危險四頁（sessionStorage 記住分頁）
- **統一翻頁圓鍵**：圖片與視頻都顯示 ‹ ›，**錨定媒體層 `.lb-media` 左右緣**（不是螢幕邊緣）；
  圖片另保留左右半區點擊；加大版桌面 66px／手機 56px，手指易撾
- **刷新策略（手機端即時更新）**：HTML／JS／CSS 設 `Cache-Control: no-cache`——每次向伺服器
  確認、沒變更即 304 零字節；圖片／縮圖／中圖／視頻設一年 `immutable`，前端 URL 自動帶
  `?v=mtime.size` 指紋（替換同名檔案即換 URL，長緩存與改檔兩得）；API 一律 `no-store`；
  由 app 層中間件統一實現（404 等錯誤回應唔會落入長緩存）
- **閘門 GET 直入**：查看密碼啟用時 `https://gallery.hkquant.com/?password=4–12位數字`
  （或 `?pwd=`）驗證通過即寫入 30 天查看會話 Cookie 並 302 跳返乾淨 URL——書籤／手機快捷方式
  直接進場；密碼錯／鎖定時不洩露原因、照常渲染閘卡；閘門關閉時參數無視
- e2e 擴至 233 項（zip 內容／越界剔除／數量上限、stats 結構與重置、定時索引邊界、
  /mid 尺寸與刪除同步清兩層緩存、entry w/h、視頻縮圖 200＋快取重用、緩存頭、
  GET ?password 直入與降級；計數斷言改隨 ffmpeg 可用性動態）

## v1.5.0（2026-11-16）
- **修復管理模式按鈕與日期／檔名重疊**：`.card-actions` 原本錨定卡片底部，開啟縮略圖資訊
  （日期／檔名）時按鈕疊在 figcaption 上；改為圖片／視頻瓦片外包 `.card-media` 定位層，
  按鈕恆疊於圖片底部，figcaption 照常排在圖下
- **視頻 lightbox 翻頁**：視頻時兩側顯示 ‹ › 圓形翻頁掣（點擊留給原生控件，故補掣）；
  圖片保持左右半區點擊翻頁不顯示此兩鍵；橫滑／鍵盤 ←→ 對視頻同樣有效
- **人臉搜尋（自拍找人）**：buffalo_sc 模型（SCRFD-500M 640×640 偵測＋w600k_mbf 512 維識別，
  合共 ~16MB），純 onnxruntime＋numpy＋Pillow（無 OpenCV／insightface 依賴樹）；
  新增 `app/faces.py`：模型惰性載入＋單飛鎖＋閒置自動卸載（看門狗預設 300 秒，回收約 200MB）、
  單線程推論（1.6G 共享伺服器 CPU 友善）、背景索引執行緒按 size|mtime 增量逐張節流
  （預設 1.5 秒/張，77 張約 2 分鐘）、向量以 base64(float32) 存入 `db/faces.json`、
  餘弦匹配預設閾值 0.40（POC 實測：同人 0.91／不同人 0.06）；大圖解碼前 draft 降採樣
- **端點**：`POST /api/face/search`（請求體＝圖片二進制原體，免 python-multipart；require_view；
  無模型 503／冇面 400／亂碼 400／超過 8MB 400；只回訪客可見路徑——隱藏照片與不可見資料夾即時剔除；
  首次搜尋自動觸發背景增量建索引）、`POST /api/face/index`（管理手動增量重建）、
  `GET /api/face/status`（管理：模型狀態／已索引量／進度／閒置卸載分鐘）
- **閒置卸載時間可於管理頁設置**：`POST /api/face/unload {"minutes":0–240}`（0＝常駐；
  即時生效＋持久化 settings.json，重啟自動套回；看門狗每拍重讀新值），
  管理頁「人臉索引」面板加數字輸入＋保存掣；未設置時回退 `GALLERY_FACES_IDLE_UNLOAD` 默認
- **前端**：頂欄「設置」左邊加「人臉搜尋」膠囊按鈕（高頻控件唔用下拉）→ 自拍卡
  （`<input capture="user">` 手機直啟相機／相簿＋預覽）→ 主頁只顯示匹配相片＋
  「人臉匹配 N 張」橫幅（「返回全部」還原過濾前頁碼）；過濾只影響本瀏覽器顯示層；
  管理頁新增「人臉索引」面板（狀態行＋建立/重建掣，索引中每 4 秒輪詢）；i18n 全鍵＋5 條 detail 映射
- **基建**：requirements 加 onnxruntime／numpy；compose 掛載
  `/opt/hkquant-gallery/models:/models:ro`（模型放 www 以外，重新解包不受影響）；
  `GALLERY_FACES_*` 五個環境變數均有預設（見 `.env.example`）
- **伺服器 POC（一次性容器 512m 上限實測）**：載入 0.06 秒、peak RSS 237MB、
  單張偵測 76ms＋識別 41ms、跑完主機記憶體零殘留——1.6G 環境確認 Safe 先落地
- e2e 擴至 167 項（人臉端點鑒權＋無模型 503 友好降級；完整鏈路另行以真實模型驗證）

## v1.4.0（2026-11-16）
- **視頻縮略圖＝瀏覽器端抽取第一格畫面**：隱藏 `<video>` seek 開首約 1 秒 →
  canvas 最長邊 640 → JPEG dataURL 疊於瓦片（▶ 徽標保留於海報上）；併發 3、
  12 秒超時、換頁作廢舊任務；瀏覽器解碼不了的格式自動維持 ▶ 瓦片，後端零改動
- **設置頁訪客化（無需登入）**：語言／主頁內容／縮略圖資訊／排序改為**訪客個人設置**，
  保存在本瀏覽器 Cookie（新端點 `GET/POST /api/prefs`，格式 `lang|dddd|by.desc`，1 年；
  部分更新，非法 400）；`/api/gallery` 與 `/api/lang` 為 Cookie 優先、未設置回退全局
  （服務器全局設置保留作默認值，`POST /api/settings/*` 仍僅管理員）；
  「顯示資料夾」屬全局設置，僅管理員登入後在設置頁可見；
  界面語言由「全站強制」改為「跟訪客 Cookie」
- **返回主頁與頁碼還原**：設置頁「保存」面板改「返回主頁」按鈕；管理頁登出後自動跳回首頁；
  首頁頁碼存 sessionStorage，返回時還原之前所見頁（越界自動夾到最後一頁）
- 管理模式「隱藏／刪除」按鈕底色改透明深灰；設置頁「顯示視頻（點擊可播放）」
  精簡為「顯示視頻」（視頻 lightbox 保持直接原生播放，不因海報改互動）
- e2e 擴至 162 項（訪客 prefs 結構／Cookie 生效／非法值 400／全局不受害）

## v1.3.0（2026-11-16，已部署 production）
- **視頻支援**：scanner 加 `VIDEO_EXTS`（mp4/mov/m4v/webm/ogv/mkv/avi/wmv/flv/mpg/mpeg/
  mts/m2ts/ts/3gp/vob/divx/rm/rmvb/f4v 共 20 種）＋`MEDIA_EXTS`；entry 加 `kind`
  （image｜video，視頻 captured 取 mtime、不走 EXIF）；`display` 擴為四鍵
  （date/name/photos/videos）；`/media` 原樣提供視頻，`/thumb` 對視頻回 404；
  `delete_all` 改刪媒體白名單（相片＋視頻，RAW／文件保留）；後端不解碼視頻
  （1.6G RAM 約束），前端視頻卡＝黑底 ▶ 播放瓦片、lightbox 用原生
  `<video controls playsinline>` 播放（能否播放取決於瀏覽器原生解碼）
- **設置全局化**：首頁移除工具列（資料夾膠囊／排序按鈕／localStorage 偏好全刪）；
  新端點 `POST /api/settings/sort`（captured|time|name＋desc，time 歸一 captured，
  非法 400）、`POST /api/settings/folders`（複選，null／空選／全選均歸一為全部可見）；
  `GET /api/settings` 加 `sort`／`all_folders`／`visible_folders`，`GET /api/gallery`
  加 `sort` 且資料夾可見性與相片／視頻開關在服務端過濾後才下發；
  設置頁重組為四面板（主頁內容／縮略圖資訊／排序方式／顯示資料夾）全部自動保存
- **lightbox**：移除上一張／下一張按鈕，圖片時點左半＝上一張、右半＝下一張
  （clientX 對 image rect 判半區，視頻不攔截留給控件）；新增「⬇ 下載」按鈕
  （`download` 屬性保留原檔名，視頻同樣可下載）
- **FOOTER 全域化**：抽出 `/footer.js`（`window.FooterKit.apply/refresh`），
  首頁／管理／設置三頁同款同步掛 body 最底，60 秒自動刷新，未過查看閘門靜默降級；
  順序調整：統計→儲存→資料夾→署名→「管理」按鈕固定最底
- 管理模式「隱藏／刪除」兩鍵底色改透明灰（保留藍框／紅框與二次確定）；
  管理頁面板重排：主頁標題排第一
- **雙語 UI（繁中／英文）**：新 `/i18n.js`（`window.I18N`：`t(key,vars)`／`detail()` 映射後端
  常見錯誤／`setLang()` 廣播 `i18n:lang` 即時重渲染）；語言為服務端全局設置
  （`GET /api/lang` 公開、`POST /api/settings/lang` 管理，默認 zh）；設置頁新增「界面語言」面板；
  三頁靜態文案改 `data-i18n` 屬性、JS 動態文字全部走字典；數字鍵盤功能鍵改內部代號
- e2e 擴至 153 項（MKV 識別／視頻 media 200／thumb 404／排序與資料夾端點／
  內容開關雙向過濾／語言端點預設與校验）

## v1.2.0（2026-11-16，已部署 production）
- 拍攝時間：scanner 讀 EXIF DateTimeOriginal（回退 mtime）→ entry 加 `captured`，
  增量快取 `db/meta.json`（按 大小|mtime 指紋）；默認排序改用 captured 反序（最新在前）
- 縮略圖：`GET /thumb/{path}`（Pillow、exif_transpose 擺正、draft 降採樣解碼控制
  22MP 峰值內存、JPEG 快取 `/data/thumbs`，key=大小|mtime|邊長|質量 雜湊；
  生成失敗回退原圖）；`requirements.txt` 加 pillow；前端 onerror 回退 `/media`
- 統計＋在線：`/api/gallery` 加 `stats{total,last_updated,used,limit,online}`；
  內存 presence（管理/查看會話令牌或 XFF IP 去重，180 秒窗口）
- 首页：分頁每頁 60；縮圖日期疊加＋檔名（受開關控制）；工具列合併同一行；
  暗黑默認（color-scheme: dark）；FOOTER 加年份／各資料夾張數／總張數／儲存／
  在線／最後更新，「管理」入口由頂欄遷去頁腳；頂欄右上改「設置」
- 管理操作：管理模式每張卡「隱藏／顯示」（變暗＋徽標，公眾不可見）＋「刪除」
  （二次確定）；`POST /api/photo/hide|delete`（key=對 FTP 根相對路徑，嚴格校驗）；
  危險區域「一鍵全部刪除」`POST /api/photo/delete_all`（管理密碼二次確認，
  只刪圖片白名單，非圖片／隱藏目錄保留）
- 設置頁 `/settings`＋`GET/POST /api/settings/display`：縮圖顯示拍攝日期／檔名全局開關
- **docker-compose：`/srv/ftp` 掛載 ro→rw**（刪除功能需要；寫路徑僅經 /api/photo/delete*）
- 管理頁按鈕全寬、登出紅底白字；e2e 擴至 124 項（含 delete_all 清空斷言）
- 同日微調：日期／檔名顯示默認關閉；設置頁勾選即時自動保存；FOOTER 重排（儲存獨立一行、
  「Frankie Cheung · © 年份」固定最底）；管理模式兩鍵移到圖片底部平分寬度、透明底、
  藍框（隱藏）／紅框（刪除）；拍攝日期改含時分並與檔名分行水平置中（不再疊加於圖片上，
  與操作按鈕零重疊）

## v1.1.0（2026-11-16，已部署 production）
- 首頁改版：扁平網格＋資料夾膠囊篩選（默認全部）＋名稱/時間正/反序排序
  （localStorage 偏好）、移除根目錄副標題、頁腳署名
- 查看密碼閘門：`GET /api/view/state`、`POST /api/view/login`、
  `POST /api/settings/view`（啟用/停用＋4–12 位數字密碼）；`/api/gallery` 與
  `/media` 啟用後未過閘回 403；查看會話 cookie `gallery_view` 30 天、
  改密碼清會話、5 連敗鎖 5 分鐘；前端內置數字鍵盤閘卡（免系統鍵盤）
- FTP 容量：`GET /api/storage`（du＋60 秒快取，`GALLERY_QUOTA_BYTES` 默認 10G）＋
  管理頁容量條（≥80% 轉紅）；主機 kiecsy 配額同步 5G→10G（setquota）
- 查看密碼格式校驗統一走正則回 400 友好提示（pydantic 欄位只限 max_length=64）
- 公網實測腳本 `.SCRATCH/gallery_gate_check.py`（15 項，測完自動復位閘門）；
  e2e 擴至 86 項

## v1.0.0（2026-11-16，已部署 production）
- 首個版本：FastAPI 圖庫服務 + 手機版優先靜態前端（零構建 vanilla JS）
- 首頁讀取 FTP 目錄（唯讀掛載）全部圖片，按資料夾分組 + lightbox
- 管理登入（純密碼）、修改密碼、修改圖庫資料夾（FTP 根內相對路徑）、
  修改主頁標題；數據全部 JSON（settings.json / auth.json，scrypt + 原子寫）
- 登入失敗 5 次鎖 5 分鐘；HttpOnly cookie 會話 7 天滑動續期
- /media 防目錄穿越、隱藏檔案封鎖、副檔白名單（排 svg）；前端渲染全用
  textContent（無 innerHTML）
- 部署：pack_gallery_src.py + stage_x2_gallery_deploy.sh；
  容器 hkquant-gallery @ 172.18.0.17:8000（NPM proxy host 10 / 證書 npm-9）
