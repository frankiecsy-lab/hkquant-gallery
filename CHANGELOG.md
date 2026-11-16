# Changelog — hkquant-gallery

## v1.2.0（2026-11-16）
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
