# FILE_MAP — hkquant-gallery

- `app/main.py` — FastAPI 路由總入口：公開 API（gallery/media/thumb）、認證接口、查看密碼閘門（require_view）、在線 presence、容量統計、照片隱藏/刪除（含一鍵全刪）、顯示開關、路徑安全校驗（防穿越/隱藏檔/副檔白名單/絕對路徑拒絕）、靜態頁面服務
- `app/store.py` — JSON 數據層：settings/auth 原子讀寫、scrypt 密碼（管理＋查看）、會話表（管理/查看）、失敗鎖定、隱藏清單、顯示開關（日期/檔名）、損壞備份
- `app/scanner.py` — 圖庫目錄遞歸掃描（副檔白名單、跳隱藏檔、分組、TTL 緩存、截斷上限）＋EXIF 拍攝時間提取（meta.json 增量快取、purge/prune）
- `app/config.py` — 環境變數配置（FTP 根、數據目錄、cookie/鎖定策略、配額字節數、縮略圖尺寸/質量、在線窗口）
- `web/index.html` + `web/app.js` — 首頁：膠囊篩選＋排序同行工具列、縮圖網格（/thumb＋日期疊加＋分頁每頁 60）、lightbox（鍵盤/觸控，限當前頁）、管理模式卡片隱藏/刪除按鈕、FOOTER 統計＋管理入口、查看密碼數字鍵盤閘卡
- `web/settings.html` + `web/settings.js` — 設置頁（僅管理員）：縮圖顯示拍攝日期／檔名開關
- `web/admin.html` + `web/admin.js` — 管理頁：登入、主頁標題、圖庫資料夾、FTP 容量條、查看密碼設置、修改密碼、危險區域（一鍵全部刪除＋密碼二次確認）、登出（按鈕全寬，登出紅底白字）
- `web/style.css` — 全站共用暗黑主題（#00e6a8）、分頁/卡片按鈕/容量條/閘卡樣式、響應式/手機微調
- `Dockerfile` / `docker-compose.yml` — 生產鏡像與編排（靜態 IP 172.18.0.17、/srv/ftp 可寫掛載——刪除功能需要）
- `requirements.txt` — 運行依賴（fastapi、uvicorn、pillow）
- `.env.example` — 環境變數模板（真實 .env 嚴禁入庫）
