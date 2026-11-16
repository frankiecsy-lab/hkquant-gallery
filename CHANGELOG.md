# Changelog — hkquant-gallery

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
- **視頻 lightbox**：未播放前顯示第一格海報（重用瓦片抽取結果）＋中間大型播放鍵，
  左右半區點擊照樣翻上／下一頁（與圖片一致）；按播放鍵才載入原生
  `<video controls>` 播放（播放中點擊留給控件）
- 管理模式「隱藏／刪除」按鈕底色改透明深灰；設置頁「顯示視頻（點擊可播放）」
  精簡為「顯示視頻」
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
