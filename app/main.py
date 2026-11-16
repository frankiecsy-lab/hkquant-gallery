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
from typing import Optional

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

from starlette.concurrency import run_in_threadpool

from . import config, faces, scanner
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
    if candidate.suffix.lower() not in scanner.MEDIA_EXTS:
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
    photos: bool = True
    videos: bool = True


class SortBody(BaseModel):
    by: str = Field(min_length=1, max_length=16)   # "captured"|"time" 或 "name"
    desc: bool


class FoldersBody(BaseModel):
    folders: list[str] | None = None               # null＝全部可见


class LangBody(BaseModel):
    lang: str = Field(min_length=2, max_length=8)  # "zh"|"en"


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
    # 显示设置：访客 Cookie 优先，未设置时回退全局（管理端配置的站点默认值）
    prefs = _prefs_from_request(request)
    display = prefs["display"]
    visible_folders = store.get_visible_folders()  # None＝全部可见（管理页复选）

    # 隐藏照片：公众完全不可见；管理端可见但带 hidden 标记（前端变暗）
    folders = []
    visible_total = 0
    last_updated = ""
    for folder in raw_folders:
        if visible_folders is not None and folder["name"] not in visible_folders:
            continue
        images = []
        for img in folder["images"]:
            if img["kind"] == "video" and not display["videos"]:
                continue
            if img["kind"] != "video" and not display["photos"]:
                continue
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
        "display": display,
        "sort": prefs["sort"],
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
    if path.suffix.lower() in scanner.VIDEO_EXTS:
        raise HTTPException(status_code=404, detail="視頻無縮略圖")  # 前端用占位瓦片
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


def _all_folder_names() -> list[str]:
    """当前图库根下有内容的资料夹显示名（供设置页复选）。"""
    try:
        rel = store.get_root()
        gallery_root = resolve_root(rel)
    except HTTPException:
        return []
    try:
        raw_folders, _ = scanner.scan(gallery_root)
    except OSError:
        return []
    return [f["name"] for f in raw_folders]


@app.get("/api/settings", dependencies=[Depends(require_login)])
def get_settings():
    rel = store.get_root()
    return {"root": rel, "root_label": root_label(rel),
            "title": store.get_title() or config.SITE_TITLE,
            "view_enabled": store.get_view_enabled(),
            "view_has_code": store.has_view_password(),
            "display": store.get_display(),
            "sort": store.get_sort(),
            "lang": store.get_lang(),
            "all_folders": _all_folder_names(),
            "visible_folders": store.get_visible_folders()}


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
    """缩略图显示开关（拍摄日期／档案名称／相片／视频），全局生效于首页。"""
    store.set_display(body.date, body.name, body.photos, body.videos)
    return {"ok": True, "display": store.get_display()}


@app.post("/api/settings/sort", dependencies=[Depends(require_login)])
def set_sort_ep(body: SortBody):
    """全局排序设置：by=captured|time|name，desc=是否倒序（最新/A→Z 在前）。"""
    by = body.by.strip().lower()
    if by == "time":
        by = "captured"
    if by not in ("captured", "name"):
        raise HTTPException(status_code=400, detail="排序方式不合法")
    store.set_sort(by, body.desc)
    return {"ok": True, "sort": store.get_sort()}


@app.post("/api/settings/folders", dependencies=[Depends(require_login)])
def set_folders_ep(body: FoldersBody):
    """资料夹可见性（全局复选）：folders=null 恢复全部可见。"""
    if body.folders is None:
        store.set_visible_folders(None)
        return {"ok": True, "visible_folders": None}
    names = [f.strip() for f in body.folders if f.strip()]
    if set(names) == set(_all_folder_names()) or not names:
        store.set_visible_folders(None)  # 全选等同全部可见
        return {"ok": True, "visible_folders": None}
    store.set_visible_folders(names)
    return {"ok": True, "visible_folders": store.get_visible_folders()}


@app.post("/api/settings/lang", dependencies=[Depends(require_login)])
def set_lang_ep(body: LangBody):
    """界面語言（全局）：zh＝繁體中文（默認）／en＝英文。"""
    lang = body.lang.strip().lower()
    if lang not in ("zh", "en"):
        raise HTTPException(status_code=400, detail="語言選項不合法")
    store.set_lang(lang)
    return {"ok": True, "lang": lang}


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
    if target.suffix.lower() not in scanner.MEDIA_EXTS:
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
    """一键删除当前图库文件夹内全部相片与视频（含隐藏）；需管理密码二次确认。

    仅删除白名单媒体扩展名（图片＋视频），原始 RAW／文档等一律保留。
    """
    if not store.verify_password(body.password):
        raise HTTPException(status_code=403, detail="管理密碼錯誤")
    root = resolve_root(store.get_root())
    if not root.is_dir():
        raise HTTPException(status_code=400, detail="資料夾不存在")
    deleted = 0
    for path in list(root.rglob("*")):
        try:
            if not path.is_file() or path.suffix.lower() not in scanner.MEDIA_EXTS:
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

# ---------- 访客显示设置（Cookie 优先，未设置回退全局默认；仅影响外观无安全含义） ----------

def _prefs_from_request(request: Request) -> dict:
    """解析访客偏好 Cookie：格式 `lang|dddd|by.desc`（例 zh|0011|captured.1；
    dddd＝date,name,photos,videos）。嚴禁含逗號——Starlette 會為含逗號的
    Cookie 值加引號與八進位轉義，令雙端解析混亂。

    缺失或任一段非法时该段回退全局设置；返回 {lang, display, sort} 均为新对象。
    """
    lang = store.get_lang()
    display = dict(store.get_display())
    sort_cfg = dict(store.get_sort())
    parts = (request.cookies.get(config.PREFS_COOKIE_NAME) or "").split("|")
    if len(parts) == 3:
        if parts[0] in ("zh", "en"):
            lang = parts[0]
        flags = parts[1]
        if len(flags) == 4 and all(f in ("0", "1") for f in flags):
            display.update(date=flags[0] == "1", name=flags[1] == "1",
                           photos=flags[2] == "1", videos=flags[3] == "1")
        sort_parts = parts[2].split(".")
        if len(sort_parts) == 2 and sort_parts[0] in ("captured", "name") and sort_parts[1] in ("0", "1"):
            sort_cfg = {"by": sort_parts[0], "desc": sort_parts[1] == "1"}
    return {"lang": lang, "display": display, "sort": sort_cfg}


def _prefs_cookie_value(prefs: dict) -> str:
    d = prefs["display"]
    return "%s|%d%d%d%d|%s.%d" % (
        prefs["lang"], d["date"], d["name"], d["photos"], d["videos"],
        prefs["sort"]["by"], prefs["sort"]["desc"])


class PrefsBody(BaseModel):
    """部分更新：未提供（None）的段维持现状。"""
    lang: Optional[str] = None
    display: Optional[dict] = None
    sort: Optional[dict] = None


@app.get("/api/prefs")
def get_prefs(request: Request):
    """访客当前显示设置（Cookie 合并全局默认）；is_admin 供设置页条件渲染。"""
    prefs = _prefs_from_request(request)
    prefs["is_admin"] = store.check_session(request.cookies.get(config.COOKIE_NAME))
    return prefs


@app.post("/api/prefs")
def set_prefs(request: Request, body: PrefsBody):
    """更新访客显示设置：仅写本浏览器长期 Cookie，不修改服务器全局设置。"""
    prefs = _prefs_from_request(request)
    if body.lang is not None:
        lang = body.lang.strip().lower()
        if lang not in ("zh", "en"):
            raise HTTPException(status_code=400, detail="語言選項不合法")
        prefs["lang"] = lang
    if body.display is not None:
        for key in ("date", "name", "photos", "videos"):
            if key in body.display:
                prefs["display"][key] = bool(body.display[key])
    if body.sort is not None:
        by = str(body.sort.get("by", "")).strip().lower()
        if by == "time":
            by = "captured"
        if by not in ("captured", "name"):
            raise HTTPException(status_code=400, detail="排序方式不合法")
        prefs["sort"] = {"by": by, "desc": bool(body.sort.get("desc", True))}
    response = JSONResponse({"ok": True, "lang": prefs["lang"],
                             "display": prefs["display"], "sort": prefs["sort"]})
    response.set_cookie(
        key=config.PREFS_COOKIE_NAME,
        value=_prefs_cookie_value(prefs),
        max_age=config.PREFS_TTL_SECONDS,
        httponly=False,  # 纯外观偏好，非敏感
        secure=config.COOKIE_SECURE,
        samesite="lax",
        path="/",
    )
    return response


@app.get("/api/lang")
def get_lang_ep(request: Request):
    """公开界面語言（前端 i18n.js 启动时读取；访客 Cookie 优先）。"""
    return {"lang": _prefs_from_request(request)["lang"]}


# ---------- 人脸检索（自拍找人；模型缺失时 503 友好降级） ----------

def _face_scan_context() -> tuple[list[dict], set[str]]:
    """返回 (全量图片索引条目, 可检索键集合)。

    索引覆盖全部图片（含隐藏与不可见资料夹，避免开关变动就要重建）；
    可检索集合在检索时排除隐藏照片与不可见资料夹，开关即时生效。
    """
    rel = store.get_root()
    try:
        gallery_root = resolve_root(rel)
    except HTTPException:
        gallery_root = config.FTP_ROOT
    raw_folders, _ = scanner.scan(gallery_root)
    hidden = store.get_hidden()
    visible_folders = store.get_visible_folders()
    entries: list[dict] = []
    visible_keys: set[str] = set()
    for folder in raw_folders:
        folder_ok = visible_folders is None or folder["name"] in visible_folders
        for img in folder["images"]:
            if img["kind"] == "video":
                continue  # 视频不做人脸索引（1.6G RAM：后端零解码）
            entries.append({"key": img["key"], "path": img["path"],
                            "name": img["name"], "size": img["size"], "mtime": img["mtime"]})
            if folder_ok and img["key"] not in hidden:
                visible_keys.add(img["key"])
    return entries, visible_keys


@app.get("/api/face/status", dependencies=[Depends(require_login)])
def face_status():
    entries, _visible = _face_scan_context()
    st = faces.index_state()
    has_models = faces.models_available()
    return {
        "models": has_models,
        "model_loaded": faces.sessions_loaded(),
        "indexed": faces.indexed_count(),
        "total_images": len(entries),
        "pending": faces.pending_count(entries) if has_models else 0,
        "running": st["running"], "done": st["done"], "todo": st["todo"],
        "errors": st["errors"], "threshold": config.FACES_MATCH_THRESHOLD,
    }


@app.post("/api/face/index", dependencies=[Depends(require_login)])
def face_index():
    """管理端手动触发增量索引（后台节流线程，重复调用安全）。"""
    if not faces.models_available():
        raise HTTPException(status_code=503, detail="人脸检索未启用")
    entries, _visible = _face_scan_context()
    started = faces.start_index(entries)
    return {"ok": True, "started": started, "indexed": faces.indexed_count(),
            "pending": faces.pending_count(entries)}


@app.post("/api/face/search")
async def face_search(request: Request):
    """自拍找人：请求体＝图片二进制（免 multipart 依赖）；只回可见图片。"""
    require_view(request)
    if not faces.models_available():
        raise HTTPException(status_code=503, detail="人脸检索未启用")
    data = await request.body()
    if not data:
        raise HTTPException(status_code=400, detail="请上传自拍照片")
    if len(data) > config.FACES_MAX_UPLOAD:
        raise HTTPException(status_code=400, detail="自拍照片过大")
    entries, visible_keys = _face_scan_context()
    try:
        embeddings = await run_in_threadpool(faces.embed_bytes, data)
    except faces.FaceUnavailable:
        raise HTTPException(status_code=503, detail="人脸检索未启用") from None
    except Exception:  # noqa: BLE001  非法图像数据统一提示
        raise HTTPException(status_code=400, detail="照片无法解析") from None
    if not embeddings:
        raise HTTPException(status_code=400, detail="未检测到人脸")
    matches = await run_in_threadpool(
        faces.search, embeddings, config.FACES_MATCH_THRESHOLD, visible_keys)
    # 首次使用自动补建增量索引（后台节流，不打扰本次结果）
    faces.start_index(entries)
    by_key = {e["key"]: e for e in entries}
    results = [{"path": by_key[m["key"]]["path"], "name": by_key[m["key"]]["name"],
                "sim": round(m["sim"], 3)}
               for m in matches if m["key"] in by_key]
    return {"matches": results, "indexed": faces.indexed_count(),
            "threshold": config.FACES_MATCH_THRESHOLD}


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


@app.get("/footer.js")
def footer_js():
    """全站共用頁腳腳本（首頁／管理／設置同款同步）。"""
    return _serve_script("footer.js")


@app.get("/i18n.js")
def i18n_js():
    """全站雙語文案組件（繁體中文／英文，語言由設置頁全局配置）。"""
    return _serve_script("i18n.js")
