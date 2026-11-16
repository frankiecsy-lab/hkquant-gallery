"""图库目录扫描：递归收集受支持格式的图片与视频并按文件夹分组。

结果带短 TTL 内存缓存，避免首页反复刷新时重复遍历 FTP 挂载目录。
拍摄时间优先取 EXIF DateTimeOriginal（无 EXIF 回退文件 mtime），
按 (大小|mtime) 指纹增量缓存到 db/meta.json，仅新图/改动图才解析 EXIF；
视频不解析 EXIF，拍摄时间取文件 mtime。
"""
import json
import os
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from . import config

# 受支持的图片扩展名（小写比较）。svg 因可直接在浏览器执行脚本而排除。
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".avif"}
# 受支持的视频扩展名：mp4/mov/m4v/webm 现代浏览器可直接播放，其余格式由
# 浏览器自行提示不支持（前端 <video controls> 原样透传 /media）。
# 視頻副檔白名單：後端只負責識別與原樣轉發，能否播放取決於瀏覽器原生解碼
# （MP4/H.264、WebM、OGV 通用性最好；MKV/AVI/FLV 等視編碼而定）
VIDEO_EXTS = {
    ".mp4", ".mov", ".m4v", ".webm", ".ogv", ".mkv", ".avi", ".wmv", ".flv",
    ".mpg", ".mpeg", ".mts", ".m2ts", ".ts", ".3gp", ".vob", ".divx",
    ".rm", ".rmvb", ".f4v",
}
MEDIA_EXTS = IMAGE_EXTS | VIDEO_EXTS

_ROOT_LABEL = "（根目錄）"

_cache_lock = threading.Lock()
_cache: dict[str, tuple[float, list[dict], bool]] = {}

_pil_state: bool | None = None  # Pillow 可用性（None=未探测）

_meta_file = config.DATA_DIR / "db" / "meta.json"
_meta_lock = threading.Lock()
_meta: dict[str, dict] | None = None


def _pillow_ok() -> bool:
    global _pil_state
    if _pil_state is None:
        try:
            import PIL.Image  # noqa: F401  仅探测可用性
            _pil_state = True
        except Exception:
            _pil_state = False
    return _pil_state


def invalidate_cache() -> None:
    """设置变更或文件删除后清空扫描缓存。"""
    with _cache_lock:
        _cache.clear()


def purge_meta(key: str) -> None:
    """文件被删除后移除其 EXIF 缓存条目。"""
    with _meta_lock:
        meta = _meta_load_locked()
        if meta.pop(key, None) is not None:
            _meta_save_locked(meta)


def prune_meta() -> None:
    """批量删除后清掉指向不存在文件的 EXIF 缓存条目。"""
    with _meta_lock:
        meta = _meta_load_locked()
        gone = [k for k in meta if not (config.FTP_ROOT / k).is_file()]
        for k in gone:
            meta.pop(k, None)
        if gone:
            _meta_save_locked(meta)


def _is_hidden(rel: Path) -> bool:
    return any(part.startswith(".") for part in rel.parts)


def _mtime_iso(path: Path) -> str:
    return datetime.fromtimestamp(
        path.stat().st_mtime, tz=timezone.utc
    ).strftime("%Y-%m-%dT%H:%M:%S")


def _image_meta(path: Path) -> tuple[str | None, int | None, int | None]:
    """一次打开读取 EXIF DateTimeOriginal 与像素尺寸（供灯箱显示原始分辨率）。

    尺寸仅读文件头（im.size），不解码像素；无时区的 EXIF 时间按字面值输出 ISO 格式。
    """
    if not _pillow_ok():
        return None, None, None
    try:
        from PIL import Image

        with Image.open(path) as im:
            w, h = int(im.size[0]), int(im.size[1])
            exif = im.getexif()
            raw = None
            try:
                ifd = exif.get_ifd(0x8769)  # Exif IFD
                raw = ifd.get(36867) or ifd.get(36860)  # DateTimeOriginal/DateTimeDigitized
            except Exception:
                raw = None
            raw = raw or exif.get(306)  # 顶层 DateTime
            if not raw:
                return None, w, h
            text = str(raw).strip()[:19]
            # EXIF 形如 "2026:11:16 14:30:00"
            if len(text) >= 16 and text[4] == ":" and text[7] == ":":
                text = text[:4] + "-" + text[5:7] + "-" + text[8:]
                return text.replace(" ", "T", 1), w, h
            return None, w, h
    except Exception:
        pass
    return None, None, None


def _meta_load_locked() -> dict:
    """载入 EXIF 缓存（调用方须持有 _meta_lock）。"""
    global _meta
    if _meta is None:
        try:
            with _meta_file.open("r", encoding="utf-8") as fh:
                data = json.load(fh)
            _meta = data if isinstance(data, dict) else {}
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            _meta = {}
    return _meta


def _meta_save_locked(meta: dict) -> None:
    tmp = _meta_file.with_name(_meta_file.name + ".tmp")
    try:
        _meta_file.parent.mkdir(parents=True, exist_ok=True)
        with tmp.open("w", encoding="utf-8") as fh:
            json.dump(meta, fh, ensure_ascii=False)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, _meta_file)
    except OSError as exc:
        print(f"[gallery] 警告：meta.json 写入失败 {exc}", file=sys.stderr)


def _image_entry(root: Path, path: Path) -> dict:
    rel = path.relative_to(root).as_posix()
    try:
        key = path.relative_to(config.FTP_ROOT).as_posix()
    except ValueError:
        key = rel  # 图库根不在 FTP 根内（理论不会发生）的兜底
    stat = path.stat()
    is_video = path.suffix.lower() in VIDEO_EXTS
    mtime_iso = datetime.fromtimestamp(
        stat.st_mtime, tz=timezone.utc
    ).strftime("%Y-%m-%dT%H:%M:%S")
    entry = {
        "path": rel,
        "key": key,
        "name": path.name,
        "size": stat.st_size,
        "mtime": mtime_iso,
        "captured": None,
        "kind": "video" if is_video else "image",
    }
    if is_video:
        entry["captured"] = mtime_iso  # 视频无 EXIF 解析，拍摄时间取 mtime
        return entry
    # v2 指纹：加入尺寸字段（旧缓存整体重读一次，代价仅一次表头解析）
    fingerprint = f"{stat.st_size}|{int(stat.st_mtime)}|v2"
    with _meta_lock:
        meta = _meta_load_locked()
        cached = meta.get(key)
        if isinstance(cached, dict) and cached.get("k") == fingerprint:
            entry["captured"] = cached.get("t") or mtime_iso
            entry["w"], entry["h"] = cached.get("w"), cached.get("h")
        else:
            captured, w, h = _image_meta(path)
            entry["captured"] = captured or mtime_iso
            entry["w"], entry["h"] = w, h
            meta[key] = {"k": fingerprint, "t": entry["captured"], "w": w, "h": h}
    return entry


def scan(root: Path) -> tuple[list[dict], bool]:
    """扫描 root 目录，返回 (folders, truncated)。

    folders 结构：[{"name": 显示名, "count": n, "images": [...]}]，
    根目录图片排在最前，其余文件夹按路径字典序排列。
    """
    key = str(root)
    now = time.time()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < config.LIST_CACHE_TTL:
            return hit[1], hit[2]

    grouped: dict[str, list[dict]] = {}
    total = 0
    truncated = False
    if root.is_dir():
        for path in sorted(root.rglob("*"), key=lambda p: p.as_posix()):
            if not path.is_file():
                continue
            if path.suffix.lower() not in MEDIA_EXTS:
                continue
            rel = path.relative_to(root)
            if _is_hidden(rel):
                continue
            if total >= config.MAX_IMAGES:
                truncated = True
                break
            folder = rel.parent.as_posix() if rel.parent != Path(".") else _ROOT_LABEL
            grouped.setdefault(folder, []).append(_image_entry(root, path))
            total += 1

    # EXIF 缓存可能有增量更新，统一落盘一次
    with _meta_lock:
        if _meta is not None:
            _meta_save_locked(_meta)

    def sort_key(name: str) -> tuple[int, str]:
        return (0 if name == _ROOT_LABEL else 1, name)

    folders = [
        {"name": name, "count": len(images), "images": images}
        for name, images in sorted(grouped.items(), key=lambda kv: sort_key(kv[0]))
    ]
    with _cache_lock:
        _cache[key] = (now, folders, truncated)
    return folders, truncated
