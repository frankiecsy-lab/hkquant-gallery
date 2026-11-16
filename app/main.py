"""hkquant-gallery 图库服务（FastAPI）。

职责：
- 首页读取当前图库文件夹（默认 FTP 根目录）下的全部图片（含拍摄时间/统计）
- 管理端：登录、修改密码、修改图库文件夹、隐藏/删除照片、缩略图显示开关
- 图片经 /media/{path} 安全输出；/thumb/{path} 输出磁盘缓存的缩略图

路由与 JSON 约定见 .SCRATCH/gallery_api_contract.md（前后端契约）。
"""
import hashlib
import os
import re
import threading
import time
from pathlib import Path

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

from . import config, scanner
from .store import Store

app = FastAPI(title=config.SITE_TITLE, docs_url=None, redoc_url=None)
store = Store(config.DATA_DIR, config.INITIAL_ADMIN_PASSWORD)

_ROOT_DISPLAY = "FTP 根目錄"
# 相对路径单段合法性：允许中文与常见安全字符，禁止以点开头（隐藏文件）与分隔符。
_SEGMENT_RE = re.compile(r"^[^/\\:*?\"<>|.\x00-\x1f][^/\\:*?\"<>|\x00-\x1f]*$")


# ---------- 路径工具（防目录穿越） ----------

def normalize_root(value: str) -> str:
    """规范化并校验图库文件夹相对路径，返回 posix 字符串（"." 表示根）。"""
    value = (value or "").strip().replace("\\", "/")
    if value in ("", "."):
        return "."
    value = value.strip("/")
    # 仅允许相对 FTP 根的路径：拒绝绝对路径、盘符与上级引用。
    if value.startswith("/") or ":" in value.split("/")[0]:
        raise HTTPException(status_code=400, detail="不允許的絕對路徑")
    parts = value.split("/")
    # 允许 "./" 形式的冗余段；其余段必须合法（拒绝 ".."、空段与隐藏名）。
    parts = [p for p in parts if p != "."]
    if not parts:
        return "."
    for part in parts:
        if part in ("", "..") or not _SEGMENT_RE.match(part):
            raise HTTPException(status_code=400, detail=f"資料夾路徑不合法：{part or value}")
    return "/".join(parts)


def resolve_root(rel: str) -> Path:
    """相对路径 → FTP 根内的实际目录，并确保不越界。"""
    base = config.FTP_ROOT
    candidate = (base / rel).resolve()
    if candidate != base and base not in candidate.parents:
        raise HTTPException(status_code=400, detail="資料夾超出 FTP 根目錄範圍")
    return candidate


def resolve_media(rel_path: str) -> Path:
    """解析 /media 相对路径为图库根内的受控文件。"""
    gallery_root = resolve_root(store.get_root())
    value = (rel_path or "").replace("\\", "/").lstrip("/")
    parts = [p for p in value.split("/") if p != ""]
    # 拒绝上级引用与隐藏文件/目录（列表本已跳过，直连 URL 同样不可达）。
    if not parts or any(p in (".", "..") or p.startswith(".") for p in parts):
        raise HTTPException(status_code=404, detail="找不到圖片")
    candidate = (gallery_root / "/".join(parts)).resolve()
    if candidate != gallery_root and gallery_root not in candidate.parents:
        raise HTTPException(status_code=404, detail="找不到圖片")
    if not candidate.is_file():
        raise HTTPException(status_code=404, detail="找不到圖片")
    if candidate.suffix.lower() not in scanner.IMAGE_EXTS:
        raise HTTPException(status_code=404, detail="找不到圖片")
    return candidate


def root_label(rel: str) -> str:
    return _ROOT_DISPLAY if rel == "." else rel


# ---------- 请求模型 ----------

class LoginBody(BaseModel):
    password: str = Field(min_length=1, max_length=256)


class RootBody(BaseModel):
    root: str = Field(min_length=1, max_length=512)


class PasswordBody(BaseModel):
    old_password: str = Field(min_length=1, max_length=256)
    new_password: str = Field(min_length=1, max_length=256)


class TitleBody(BaseModel):
    title: str = Field(min_length=1, max_length=80)


# 长度上限只防超大请求体；4–12 位数字的规则统一由 _CODE_RE 校验（回 400 友好提示）
class ViewLoginBody(BaseModel):
    code: str = Field(min_length=1, max_length=64)


class ViewSettingBody(BaseModel):
    enabled: bool
    code: str = Field(default="", max_length=64)


class DisplayBody(BaseModel):
    date: bool
    name: bool


class HideBody(BaseModel):
    key: str = Field(min_length=1, max_length=512)
    hidden: bool


class DeleteBody(BaseModel):
    key: str = Field(min_length=1, max_length=512)


class DeleteAllBody(BaseModel):
    password: str = Field(min_length=1, max_length=256)


_CODE_RE = re.compile(r"^\d{4,12}$")


# ---------- 认证依赖 ----------

def require_login(request: Request) -> None:
    token = request.cookies.get(config.COOKIE_NAME)
    if not store.check_session(token):
        raise HTTPException(status_code=401, detail="請先登入")


def require_view(request: Request) -> None:
    """看相闸门：启用查看密码后，管理员会话或查看会话任一有效才放行。"""
    if not store.get_view_enabled():
        return
    if store.check_session(request.cookies.get(config.COOKIE_NAME)):
        return
    if store.check_view_session(request.cookies.get(config.VIEW_COOKIE_NAME)):
        return
    raise HTTPException(status_code=403, detail="請輸入查看密碼")


def _set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=config.COOKIE_NAME,
        value=token,
        max_age=config.SESSION_TTL_SECONDS,
        httponly=True,
        secure=config.COOKIE_SECURE,
        samesite="lax",
        path="/",
    )


# ---------- 在线访客（内存去重，不持久化） ----------

_presence_lock = threading.Lock()
_presence: dict[str, float] = {}


def _visitor_id(request: Request) -> str:
    """访客标识：管理/查看会话按令牌去重，匿名按来源 IP（经 NPM 取 XFF）。"""
    admin = request.cookies.get(config.COOKIE_NAME)
    if admin:
        return "a:" + hashlib.sha256(admin.encode()).hexdigest()[:16]
    view = request.cookies.get(config.VIEW_COOKIE_NAME)
    if view:
        return "v:" + hashlib.sha256(view.encode()).hexdigest()[:16]
    xff = request.headers.get("x-forwarded-for", "")
    ip = xff.split(",")[0].strip() if xff else (
        request.client.host if request.client else "?")
    return "i:" + hashlib.sha256(ip.encode()).hexdigest()[:16]


def _touch_presence(request: Request) -> int:
    """记录本次活动并返回窗口内在线人数。"""
    visitor = _visitor_id(request)
    now = time.time()
    with _presence_lock:
        _presence[visitor] = now
        for stale in [k for k, t in _presence.items() if now - t > 600]:
            _presence.pop(stale, None)
        return sum(1 for t in _presence.values()
                   if now - t <= config.ONLINE_WINDOW_SECONDS)


# ---------- 存储用量（60 秒缓存，管理页与首页统计共用） ----------

_storage_lock = threading.Lock()
_storage_cache: tuple[float, int] = (0.0, 0)

STORAGE_CACHE_TTL = 60.0


def _storage_used() -> int:
    global _storage_cache
    now = time.time()
    with _storage_lock:
        ts, used = _storage_cache
        if now - ts < STORAGE_CACHE_TTL:
            return used
    total = 0
    for path in config.FTP_ROOT.rglob("*"):
        try:
            if path.is_file():
                total += path.stat().st_size
        except OSError:
            continue
    with _storage_lock:
        _storage_cache = (now, total)
    return total


def _storage_reset_cache() -> None:
    global _storage_cache
    with _storage_lock:
        _storage_cache = (0.0, 0)


# ---------- 公开接口 ----------

@app.get("/api/healthz")
def healthz():
    return {"status": "ok"}


@app.get("/api/gallery")
def gallery(request: Request):
    require_view(request)
    is_admin = store.check_session(request.cookies.get(config.COOKIE_NAME))
    hidden = store.get_hidden()
    rel = store.get_root()
    try:
        gallery_root = resolve_root(rel)
    except HTTPException:
        gallery_root = config.FTP_ROOT
        rel = "."
    raw_folders, truncated = scanner.scan(gallery_root)

    # 隐藏照片：公众完全不可见；管理端可见但带 hidden 标记（前端变暗）
    folders = []
    visible_total = 0
    last_updated = ""
    for folder in raw_folders:
        images = []
        for img in folder["images"]:
            is_hidden = img["key"] in hidden
            if is_hidden and not is_admin:
                continue
            if not is_hidden:
                visible_total += 1
                if img["captured"] > last_updated:
                    last_updated = img["captured"]
            entry = dict(img)
            if is_hidden:
                entry["hidden"] = True
            if not is_admin:
                entry.pop("key", None)  # 公众不下发 FTP 相对键
            images.append(entry)
        if images:
            folders.append({"name": folder["name"], "count": len(images), "images": images})

    used = _storage_used()
    payload = {
        # 标题优先取管理页设置，未设置时回退环境变量默认值。
        "title": store.get_title() or config.SITE_TITLE,
        "root_label": root_label(rel),
        "folders": folders,
        "is_admin": is_admin,
        "display": store.get_display(),
        "stats": {
            "total": visible_total,
            "last_updated": last_updated,
            "used": used,
            "limit": config.QUOTA_BYTES,
            "online": _touch_presence(request),
        },
    }
    if truncated:
        payload["truncated"] = True
    return payload


@app.get("/media/{rel_path:path}")
def media(rel_path: str, request: Request):
    require_view(request)
    path = resolve_media(rel_path)
    _touch_presence(request)
    # 图片名可能含中文：交由 FileResponse 处理编码与 MIME。
    return FileResponse(path)


# ---------- 缩略图（磁盘缓存，Pillow 生成） ----------

def _make_thumb(path: Path, out: Path) -> bool:
    """生成缩略图 JPEG；Pillow 缺失或解码失败返回 False（调用方回退原图）。"""
    if not scanner._pillow_ok():
        return False
    try:
        from PIL import Image, ImageOps

        with Image.open(path) as im:
            try:
                # JPEG 可先降采样解码，控制 20MP+ 相片的峰值内存
                im.draft("RGB", (config.THUMB_MAX_SIDE * 2, config.THUMB_MAX_SIDE * 2))
            except ValueError:
                pass
            im = ImageOps.exif_transpose(im)  # 按 EXIF 方向摆正
            im.thumbnail((config.THUMB_MAX_SIDE, config.THUMB_MAX_SIDE))
            if im.mode not in ("RGB", "L"):
                im = im.convert("RGB")
            config.THUMB_DIR.mkdir(parents=True, exist_ok=True)
            tmp = out.with_name(f"{out.name}.{threading.get_ident()}.tmp")
            im.save(tmp, "JPEG", quality=config.THUMB_QUALITY, optimize=True)
            os.replace(tmp, out)
        return True
    except Exception:
        return False


@app.get("/thumb/{rel_path:path}")
def thumb(rel_path: str, request: Request):
    require_view(request)
    path = resolve_media(rel_path)
    _touch_presence(request)
    stat = path.stat()
    stamp = hashlib.sha1(
        f"{stat.st_size}|{int(stat.st_mtime)}|{config.THUMB_MAX_SIDE}|{config.THUMB_QUALITY}".encode()
    ).hexdigest()
    out = config.THUMB_DIR / f"{stamp}.jpg"
    if not out.is_file() and not _make_thumb(path, out):
        return FileResponse(path)  # 回退原图：旧浏览器缓存/无 Pillow 场景仍可用
    return FileResponse(out, media_type="image/jpeg")


# ---------- 认证接口 ----------

@app.post("/api/login")
def login(body: LoginBody):
    if store.locked_until() > time.time():
        raise HTTPException(status_code=429, detail="嘗試過多，請稍後再試")
    if not store.verify_password(body.password):
        store.record_login_failure()
        raise HTTPException(status_code=401, detail="密碼錯誤")
    store.clear_login_failures()
    token = store.create_session()
    response = JSONResponse({"ok": True})
    _set_session_cookie(response, token)
    return response


@app.post("/api/logout")
def logout(request: Request, response: Response):
    store.delete_session(request.cookies.get(config.COOKIE_NAME))
    response.delete_cookie(config.COOKIE_NAME, path="/")
    return {"ok": True}


@app.get("/api/session")
def session_state(request: Request):
    return {"logged_in": store.check_session(request.cookies.get(config.COOKIE_NAME))}


@app.get("/api/settings", dependencies=[Depends(require_login)])
def get_settings():
    rel = store.get_root()
    return {"root": rel, "root_label": root_label(rel),
            "title": store.get_title() or config.SITE_TITLE,
            "view_enabled": store.get_view_enabled(),
            "view_has_code": store.has_view_password(),
            "display": store.get_display()}


@app.post("/api/settings/view", dependencies=[Depends(require_login)])
def set_view(body: ViewSettingBody):
    """设置查看密码闸门：可顺带更新数字密码；启用前必须已有密码。"""
    if body.code:
        if not _CODE_RE.match(body.code):
            raise HTTPException(status_code=400, detail="查看密碼須為 4–12 位數字")
        store.set_view_password(body.code)
    if body.enabled and not store.has_view_password():
        raise HTTPException(status_code=400, detail="請先設置查看密碼")
    store.set_view_enabled(body.enabled)
    if not body.enabled:
        store.clear_view_sessions()
    return {"ok": True, "view_enabled": body.enabled,
            "view_has_code": store.has_view_password()}


@app.post("/api/settings/title", dependencies=[Depends(require_login)])
def set_title(body: TitleBody):
    title = body.title.strip()
    if not title:
        raise HTTPException(status_code=400, detail="標題不能為空")
    store.set_title(title)
    return {"ok": True, "title": title}


@app.post("/api/settings/display", dependencies=[Depends(require_login)])
def set_display_ep(body: DisplayBody):
    """缩略图显示开关（拍摄日期／档案名称），全局生效于首页。"""
    store.set_display(body.date, body.name)
    return {"ok": True, "display": store.get_display()}


# ---------- 照片管理（隐藏／删除；key = 相对 FTP 根的 posix 路径） ----------

def _resolve_ftp_key(key: str) -> Path:
    """校验照片键并解析为 FTP 根内文件路径（拒绝越界/隐藏/非法段）。"""
    value = (key or "").strip().replace("\\", "/")
    # 明确要求相对路径：绝对路径与盘符直接拒绝（不静默转为相对）
    if value.startswith("/") or (value.split("/")[0] if value else "").find(":") >= 0:
        raise HTTPException(status_code=400, detail="不允許的絕對路徑")
    parts = [p for p in value.split("/") if p and p != "."]
    if not parts or any(p == ".." or not _SEGMENT_RE.match(p) for p in parts):
        raise HTTPException(status_code=400, detail="照片路徑不合法")
    candidate = (config.FTP_ROOT / "/".join(parts)).resolve()
    if candidate == config.FTP_ROOT or config.FTP_ROOT not in candidate.parents:
        raise HTTPException(status_code=400, detail="照片路徑超出範圍")
    return candidate


def _resolve_photo(key: str) -> tuple[Path, str]:
    target = _resolve_ftp_key(key)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="找不到圖片")
    if target.suffix.lower() not in scanner.IMAGE_EXTS:
        raise HTTPException(status_code=400, detail="不支援的檔案類型")
    return target, target.relative_to(config.FTP_ROOT).as_posix()


@app.post("/api/photo/hide", dependencies=[Depends(require_login)])
def photo_hide(body: HideBody):
    _, key = _resolve_photo(body.key)
    store.set_photo_hidden(key, body.hidden)
    scanner.invalidate_cache()
    return {"ok": True, "key": key, "hidden": body.hidden}


@app.post("/api/photo/delete", dependencies=[Depends(require_login)])
def photo_delete(body: DeleteBody):
    """直接删除照片文件（需 FTP 挂载可写）；前端已做二次确认。"""
    target, key = _resolve_photo(body.key)
    try:
        target.unlink()
    except OSError:
        raise HTTPException(status_code=500, detail="刪除失敗（檔案系統錯誤或掛載唯讀）")
    store.forget_photo(key)
    scanner.purge_meta(key)
    scanner.invalidate_cache()
    _storage_reset_cache()
    return {"ok": True, "key": key}


@app.post("/api/photo/delete_all", dependencies=[Depends(require_login)])
def photo_delete_all(body: DeleteAllBody):
    """一键删除当前图库文件夹内全部图片（含隐藏）；需管理密码二次确认。

    仅删除白名单图片扩展名文件，非图片（原始 RAW/视频等）一律保留。
    """
    if not store.verify_password(body.password):
        raise HTTPException(status_code=403, detail="管理密碼錯誤")
    root = resolve_root(store.get_root())
    if not root.is_dir():
        raise HTTPException(status_code=400, detail="資料夾不存在")
    deleted = 0
    for path in list(root.rglob("*")):
        try:
            if not path.is_file() or path.suffix.lower() not in scanner.IMAGE_EXTS:
                continue
            rel = path.relative_to(root)
            if any(part.startswith(".") for part in rel.parts):
                continue  # 隐藏体系外文件不动（与扫描规则一致）
            path.unlink()
            deleted += 1
        except OSError:
            continue
    # 清理已不存在文件的残留记录（隐藏清单与 EXIF 缓存）
    hidden = store.get_hidden()
    survivors = {k for k in hidden if (config.FTP_ROOT / k).is_file()}
    if survivors != hidden:
        store.replace_hidden(survivors)
    scanner.prune_meta()
    scanner.invalidate_cache()
    _storage_reset_cache()
    return {"ok": True, "deleted": deleted}


# ---------- 查看密码（首页闸门） ----------

@app.get("/api/view/state")
def view_state():
    return {"enabled": store.get_view_enabled()}


@app.post("/api/view/login")
def view_login(body: ViewLoginBody):
    if not store.get_view_enabled():
        return {"ok": True}
    if not _CODE_RE.match(body.code):
        raise HTTPException(status_code=400, detail="查看密碼須為 4–12 位數字")
    if store.view_locked_until() > time.time():
        raise HTTPException(status_code=429, detail="嘗試過多，請稍後再試")
    if not store.verify_view_password(body.code):
        store.record_view_failure()
        raise HTTPException(status_code=401, detail="密碼錯誤")
    store.clear_view_failures()
    response = JSONResponse({"ok": True})
    response.set_cookie(
        key=config.VIEW_COOKIE_NAME,
        value=store.create_view_session(),
        max_age=config.VIEW_SESSION_TTL_SECONDS,
        httponly=True,
        secure=config.COOKIE_SECURE,
        samesite="lax",
        path="/",
    )
    return response


# ---------- 存储容量（FTP 配额；管理页专用，首页统计走 /api/gallery.stats） ----------

@app.get("/api/storage", dependencies=[Depends(require_login)])
def storage():
    """返回 FTP 根目录用量（用于管理页容量条；配额与主机 setquota 一致）。"""
    used = _storage_used()
    return {"used": used, "limit": config.QUOTA_BYTES,
            "free": max(0, config.QUOTA_BYTES - used)}


@app.post("/api/settings/root", dependencies=[Depends(require_login)])
def set_root(body: RootBody):
    rel = normalize_root(body.root)
    target = resolve_root(rel)
    if not target.is_dir():
        raise HTTPException(status_code=400, detail="資料夾不存在")
    store.set_root(rel)
    scanner.invalidate_cache()
    return {"ok": True, "root": rel, "root_label": root_label(rel)}


@app.post("/api/settings/password", dependencies=[Depends(require_login)])
def set_password(body: PasswordBody):
    if not store.verify_password(body.old_password):
        raise HTTPException(status_code=400, detail="原密碼錯誤")
    if len(body.new_password) < 8:
        raise HTTPException(status_code=400, detail="新密碼至少 8 個字符")
    store.set_password(body.new_password)
    return {"ok": True}


# ---------- 前端页面 ----------

@app.get("/")
def index():
    return FileResponse(config.WEB_DIR / "index.html")


@app.get("/admin")
def admin_page():
    return FileResponse(config.WEB_DIR / "admin.html")


@app.get("/settings")
def settings_page():
    return FileResponse(config.WEB_DIR / "settings.html")


@app.get("/style.css")
def style_css():
    return FileResponse(config.WEB_DIR / "style.css", media_type="text/css")


def _serve_script(name: str):
    path = config.WEB_DIR / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Not Found")
    return FileResponse(path, media_type="application/javascript")


@app.get("/app.js")
def app_js():
    return _serve_script("app.js")


@app.get("/admin.js")
def admin_js():
    return _serve_script("admin.js")


@app.get("/settings.js")
def settings_js():
    return _serve_script("settings.js")
