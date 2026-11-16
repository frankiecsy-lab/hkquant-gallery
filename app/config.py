"""运行期配置。

所有可调项均来自环境变量（禁止硬编码敏感信息），并提供适用于
Windows 本地开发与 Linux/Docker 生产环境的默认值。
"""
import os
from pathlib import Path

# FTP 根目录：生产环境由 compose 以可写方式挂载 /srv/ftp（照片删除功能需要）；
# 本地开发通过 GALLERY_FTP_ROOT 指向任意测试目录。
FTP_ROOT = Path(os.environ.get("GALLERY_FTP_ROOT", "/srv/ftp")).resolve()

# 应用数据目录（settings.json / auth.json 等 JSON 存储）。
DATA_DIR = Path(os.environ.get("GALLERY_DATA_DIR", "data")).resolve()

# 站点标题（首页显示）。
SITE_TITLE = os.environ.get("GALLERY_TITLE", "HKQuant Gallery")

# 管理员初始密码：仅在 auth.json 尚未建立时生效；未提供时自动生成
# 一次性随机密码并打印到标准输出。
INITIAL_ADMIN_PASSWORD = os.environ.get("GALLERY_ADMIN_PASSWORD", "")

# 单次列表最多返回的图片数量，防止超大目录拖死请求。
MAX_IMAGES = int(os.environ.get("GALLERY_MAX_IMAGES", "20000"))

# 目录扫描结果的内存缓存有效期（秒）。
LIST_CACHE_TTL = float(os.environ.get("GALLERY_LIST_TTL", "5"))

# 会话 Cookie 是否带 Secure 标志（生产经 NPM 强制 HTTPS，须保留；
# 本地以 http 调试时可设 GALLERY_COOKIE_SECURE=0）。
COOKIE_SECURE = os.environ.get("GALLERY_COOKIE_SECURE", "1") != "0"

# 会话有效期与登录失败锁定策略。
SESSION_TTL_SECONDS = 7 * 24 * 3600
# 查看密码会话较长，避免手机每次打开都要输入数字。
VIEW_SESSION_TTL_SECONDS = 30 * 24 * 3600
MAX_FAILED_LOGINS = 5
LOCKOUT_SECONDS = 300

# FTP 账户存储配额（字节），用于管理页容量显示；与主机 setquota 保持一致。
QUOTA_BYTES = int(os.environ.get("GALLERY_QUOTA_BYTES", str(10 * 1024 ** 3)))

# 会话 Cookie 名称（前后端唯一约定）。
COOKIE_NAME = "gallery_session"
VIEW_COOKIE_NAME = "gallery_view"
# 访客显示设置 Cookie（语言／内容开关／排序，仅影响本浏览器，长期保存）。
PREFS_COOKIE_NAME = "gallery_prefs"
PREFS_TTL_SECONDS = 60 * 60 * 24 * 365

# 缩略图：最长边像素与 JPEG 质量（1.6G RAM：解码前 draft 降采样，峰值内存可控）。
THUMB_MAX_SIDE = int(os.environ.get("GALLERY_THUMB_MAX_SIDE", "640"))
THUMB_QUALITY = int(os.environ.get("GALLERY_THUMB_QUALITY", "80"))
THUMB_DIR = DATA_DIR / "thumbs"

# 中图（/mid，灯箱放大图专用）：1600px 长边远小于原图，加载快数倍；
# 原图仅经 /media 用于单张下载与 ZIP 打包。删除照片时两层缓存同步清除。
MID_MAX_SIDE = int(os.environ.get("GALLERY_MID_MAX_SIDE", "1600"))
MID_QUALITY = int(os.environ.get("GALLERY_MID_QUALITY", "85"))
MID_DIR = DATA_DIR / "mids"

# 人脸检索（buffalo_sc：det_500m.onnx＋w600k_mbf.onnx，compose 只读挂载 /models）。
# 1.6G RAM 约束：模型惰性加载＋闲置自动卸载；后台索引按张节流；模型目录缺失时接口 503。
FACES_MODEL_DIR = Path(os.environ.get("GALLERY_FACES_DIR", "/models")).resolve()
FACES_DB = DATA_DIR / "faces.json"
# 余弦相似度匹配阈值（POC：同人 0.91／不同人 0.06，0.40 留有充分余量）。
FACES_MATCH_THRESHOLD = float(os.environ.get("GALLERY_FACES_THRESHOLD", "0.40"))
# 后台索引每张图之间的休眠秒数（共享服务器 CPU 友好；77 张约 2 分钟）。
FACES_INDEX_INTERVAL = float(os.environ.get("GALLERY_FACES_INDEX_INTERVAL", "1.5"))
# 闲置超过该秒数自动卸载模型释放内存（0＝常驻不卸载）。
FACES_IDLE_UNLOAD_SECONDS = float(os.environ.get("GALLERY_FACES_IDLE_UNLOAD", "300"))
# 自拍上传体积上限（字节）。
FACES_MAX_UPLOAD = int(os.environ.get("GALLERY_FACES_MAX_UPLOAD", str(8 * 1024 * 1024)))

STATS_DB = DATA_DIR / "stats.json"  # 訪問統計（按日匯總＋最近事件；管理頁可重置）

# 批量下載（ZIP 流式打包）：單次檔數／總量上限；開放與否為全站設置（默認關閉）
DOWNLOAD_MAX_FILES = int(os.environ.get("GALLERY_DOWNLOAD_MAX_FILES", "500"))
DOWNLOAD_MAX_BYTES = int(os.environ.get("GALLERY_DOWNLOAD_MAX_BYTES", str(2 * 1024 ** 3)))

# “在线人数”按最后活动于此窗口内（秒）的访问者去重统计。
ONLINE_WINDOW_SECONDS = 180

# 前端静态页面目录（与本包同级的 web/）。
WEB_DIR = Path(__file__).resolve().parent.parent / "web"
