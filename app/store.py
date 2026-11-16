"""JSON 数据层：设置与认证数据全部持久化为 JSON 文件。

- settings.json：图库当前文件夹（相对 FTP 根的 POSIX 路径）
- auth.json：管理员密码散列（scrypt）、会话表、登录失败锁定状态

写入采用“临时文件 + 原子替换”，并以线程锁串行化，避免并发损坏。
"""
import hashlib
import hmac
import json
import os
import secrets
import sys
import threading
import time
from pathlib import Path

from . import config

_SCRYPT_N = 2 ** 14
_SCRYPT_R = 8
_SCRYPT_P = 1


def _hash_password(password: str, salt_hex: str | None = None) -> str:
    """返回 "scrypt$<salt_hex>$<hash_hex>" 格式散列。"""
    salt = bytes.fromhex(salt_hex) if salt_hex else secrets.token_bytes(16)
    digest = hashlib.scrypt(
        password.encode("utf-8"), salt=salt, n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P
    )
    return f"scrypt${salt.hex()}${digest.hex()}"


def _verify_password(password: str, stored: str) -> bool:
    try:
        scheme, salt_hex, hash_hex = stored.split("$", 2)
        if scheme != "scrypt":
            return False
        return hmac.compare_digest(_hash_password(password, salt_hex), stored)
    except (ValueError, AttributeError):
        return False


class Store:
    """线程安全的 JSON 存储封装（设置 + 认证）。"""

    def __init__(self, data_dir: Path, initial_password: str = ""):
        self._lock = threading.Lock()
        self._db_dir = data_dir / "db"
        self._db_dir.mkdir(parents=True, exist_ok=True)
        self._settings_file = self._db_dir / "settings.json"
        self._auth_file = self._db_dir / "auth.json"
        self._settings = self._load(self._settings_file, {
            "root": ".",
            "view_enabled": False,
            "hidden_photos": [],
            "display_date": False,
            "display_name": False,
            "display_photos": True,
            "display_videos": True,
            # null＝全部資料夾可見；列表＝僅所列資料夾對所有人可見（管理頁複選）
            "folders_visible": None,
            "sort_by": "captured",
            "sort_desc": True,
            # 界面語言：zh＝繁體中文（默認）／en＝英文（全局，設置頁配置）
            "lang": "zh",
        })
        self._auth = self._load(self._auth_file, {
            "password_hash": "",
            "sessions": {},
            "failures": {"count": 0, "until": 0},
            "view_password_hash": "",
            "view_sessions": {},
            "view_failures": {"count": 0, "until": 0},
        })
        if not self._auth.get("password_hash"):
            pwd = initial_password or secrets.token_urlsafe(12)
            self._auth["password_hash"] = _hash_password(pwd)
            self._save(self._auth_file, self._auth)
            if not initial_password:
                # 未提供初始密码时输出一次性随机密码，便于首次登录。
                print(f"[gallery] 已生成一次性管理员密码（请立即登录修改）: {pwd}")

    # ---------- 基础读写 ----------

    @staticmethod
    def _load(path: Path, default: dict) -> dict:
        try:
            with path.open("r", encoding="utf-8") as fh:
                data = json.load(fh)
            return data if isinstance(data, dict) else dict(default)
        except FileNotFoundError:
            return dict(default)
        except (json.JSONDecodeError, OSError):
            # 文件损坏时先备份再回退默认值（不静默丢弃现场），
            # 并按初始密码重建；管理员可从备份文件人工恢复。
            try:
                backup = path.with_name(path.name + ".corrupt")
                backup.write_bytes(path.read_bytes())
                print(f"[gallery] 警告：{path.name} 损坏，已备份到 {backup.name}"
                      " 并回退默认值", file=sys.stderr)
            except OSError:
                print(f"[gallery] 警告：{path.name} 损坏且无法备份，已回退默认值",
                      file=sys.stderr)
            return dict(default)

    @staticmethod
    def _save(path: Path, data: dict) -> None:
        tmp = path.with_name(path.name + ".tmp")
        with tmp.open("w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)

    # ---------- 设置 ----------

    def get_root(self) -> str:
        with self._lock:
            return self._settings.get("root") or "."

    def set_root(self, root: str) -> None:
        with self._lock:
            self._settings["root"] = root
            self._save(self._settings_file, self._settings)

    def get_view_enabled(self) -> bool:
        with self._lock:
            return bool(self._settings.get("view_enabled"))

    def set_view_enabled(self, enabled: bool) -> None:
        with self._lock:
            self._settings["view_enabled"] = bool(enabled)
            self._save(self._settings_file, self._settings)

    def get_title(self) -> str:
        """首页标题；未设置时返回空串，由调用方回退环境变量默认值。"""
        with self._lock:
            return self._settings.get("title") or ""

    def set_title(self, title: str) -> None:
        with self._lock:
            self._settings["title"] = title
            self._save(self._settings_file, self._settings)

    # ---------- 隐藏照片与缩略图显示开关 ----------

    def get_hidden(self) -> set[str]:
        """被管理端隐藏的照片（key = 相对 FTP 根的 posix 路径）。"""
        with self._lock:
            return set(self._settings.get("hidden_photos") or [])

    def set_photo_hidden(self, key: str, hidden: bool) -> None:
        with self._lock:
            photos = set(self._settings.get("hidden_photos") or [])
            if hidden:
                photos.add(key)
            else:
                photos.discard(key)
            self._settings["hidden_photos"] = sorted(photos)
            self._save(self._settings_file, self._settings)

    def forget_photo(self, key: str) -> None:
        """照片被删除后清理其在隐藏清单中的残留记录。"""
        self.set_photo_hidden(key, hidden=False)

    def replace_hidden(self, keys: set[str]) -> None:
        """整体替换隐藏清单（批量删除后清理残留）。"""
        with self._lock:
            self._settings["hidden_photos"] = sorted(keys)
            self._save(self._settings_file, self._settings)

    def get_display(self) -> dict:
        with self._lock:
            return {
                "date": bool(self._settings.get("display_date", False)),
                "name": bool(self._settings.get("display_name", False)),
                "photos": bool(self._settings.get("display_photos", True)),
                "videos": bool(self._settings.get("display_videos", True)),
            }

    def set_display(self, show_date: bool, show_name: bool,
                    show_photos: bool = True, show_videos: bool = True) -> None:
        with self._lock:
            self._settings["display_date"] = bool(show_date)
            self._settings["display_name"] = bool(show_name)
            self._settings["display_photos"] = bool(show_photos)
            self._settings["display_videos"] = bool(show_videos)
            self._save(self._settings_file, self._settings)

    # ---------- 资料夹可见性（管理页全局复选；None＝全部可见） ----------

    def get_visible_folders(self):
        with self._lock:
            value = self._settings.get("folders_visible", None)
            return None if value is None else sorted(set(value))

    def set_visible_folders(self, folders) -> None:
        """folders=None 恢复全部可见；列表则仅所列资料夹对所有人可见。"""
        with self._lock:
            self._settings["folders_visible"] = (
                None if folders is None else sorted(set(folders)))
            self._save(self._settings_file, self._settings)

    # ---------- 全局排序（设置页统一配置，首页按此显示） ----------

    def get_sort(self) -> dict:
        with self._lock:
            return {
                "by": self._settings.get("sort_by", "captured"),
                "desc": bool(self._settings.get("sort_desc", True)),
            }

    def set_sort(self, by: str, desc: bool) -> None:
        with self._lock:
            self._settings["sort_by"] = by
            self._settings["sort_desc"] = bool(desc)
            self._save(self._settings_file, self._settings)

    # ---------- 界面語言（全局，默認繁體中文） ----------

    def get_lang(self) -> str:
        with self._lock:
            lang = self._settings.get("lang", "zh")
            return lang if lang in ("zh", "en") else "zh"

    def set_lang(self, lang: str) -> None:
        with self._lock:
            self._settings["lang"] = lang
            self._save(self._settings_file, self._settings)

    # ---------- 人脸模型闲置卸载时间 ----------

    def get_face_idle_minutes(self) -> int:
        """管理页设置的闲置卸载分钟数；-1 表示未设置（回退环境变量默认）。"""
        with self._lock:
            value = self._settings.get("face_idle_minutes", -1)
            return value if isinstance(value, int) and not isinstance(value, bool) else -1

    def set_face_idle_minutes(self, minutes: int) -> None:
        with self._lock:
            self._settings["face_idle_minutes"] = minutes
            self._save(self._settings_file, self._settings)

    # ---------- 人臉定時索引（背景自動增量；默認關閉） ----------

    def get_face_auto_index(self) -> tuple[bool, int]:
        """回傳 (啟用與否, 間隔分鐘)；間夾鉗在 5–1440。"""
        with self._lock:
            on = bool(self._settings.get("face_auto_index", False))
            mins = self._settings.get("face_auto_index_minutes", 10)
            if not isinstance(mins, int) or isinstance(mins, bool):
                mins = 10
            return on, min(1440, max(5, mins))

    def set_face_auto_index(self, enabled: bool, minutes: int) -> None:
        with self._lock:
            self._settings["face_auto_index"] = bool(enabled)
            self._settings["face_auto_index_minutes"] = int(minutes)
            self._save(self._settings_file, self._settings)

    # ---------- 批量下載（全站開關；默認關閉，管理頁可開放） ----------

    def get_downloads_enabled(self) -> bool:
        with self._lock:
            return bool(self._settings.get("downloads_enabled", False))

    def set_downloads_enabled(self, enabled: bool) -> None:
        with self._lock:
            self._settings["downloads_enabled"] = bool(enabled)
            self._save(self._settings_file, self._settings)

    # ---------- 密码 ----------

    def verify_password(self, password: str) -> bool:
        with self._lock:
            stored = self._auth.get("password_hash", "")
        return bool(stored) and _verify_password(password, stored)

    def set_password(self, new_password: str) -> None:
        with self._lock:
            self._auth["password_hash"] = _hash_password(new_password)
            self._save(self._auth_file, self._auth)

    # ---------- 登录失败锁定 ----------

    def locked_until(self) -> float:
        with self._lock:
            return float(self._auth.get("failures", {}).get("until", 0) or 0)

    def record_login_failure(self) -> bool:
        """记录一次失败；返回锁定是否已触发。"""
        with self._lock:
            failures = self._auth.setdefault("failures", {"count": 0, "until": 0})
            if time.time() < float(failures.get("until", 0) or 0):
                return True
            failures["count"] = int(failures.get("count", 0)) + 1
            triggered = False
            if failures["count"] >= config.MAX_FAILED_LOGINS:
                failures["until"] = time.time() + config.LOCKOUT_SECONDS
                failures["count"] = 0
                triggered = True
            self._save(self._auth_file, self._auth)
            return triggered

    def clear_login_failures(self) -> None:
        with self._lock:
            self._auth["failures"] = {"count": 0, "until": 0}
            self._save(self._auth_file, self._auth)

    # ---------- 会话 ----------

    def create_session(self) -> str:
        token = secrets.token_urlsafe(32)
        now = time.time()
        with self._lock:
            sessions = self._auth.setdefault("sessions", {})
            # 顺手清理过期会话，防止 JSON 无限增长。
            expired = [t for t, s in sessions.items()
                       if float(s.get("expires", 0)) < now]
            for t in expired:
                sessions.pop(t, None)
            sessions[token] = {"expires": now + config.SESSION_TTL_SECONDS}
            self._save(self._auth_file, self._auth)
        return token

    def check_session(self, token: str | None) -> bool:
        if not token:
            return False
        now = time.time()
        with self._lock:
            session = self._auth.get("sessions", {}).get(token)
            if not session or float(session.get("expires", 0)) < now:
                return False
            # 滑动续期；直接落盘（频率低，可接受）。
            session["expires"] = now + config.SESSION_TTL_SECONDS
            self._save(self._auth_file, self._auth)
            return True

    def delete_session(self, token: str | None) -> None:
        if not token:
            return
        with self._lock:
            if token in self._auth.get("sessions", {}):
                self._auth["sessions"].pop(token, None)
                self._save(self._auth_file, self._auth)

    # ---------- 查看密码（首页看相闸门，与管理员体系分离） ----------

    def has_view_password(self) -> bool:
        with self._lock:
            return bool(self._auth.get("view_password_hash"))

    def set_view_password(self, code: str) -> None:
        with self._lock:
            self._auth["view_password_hash"] = _hash_password(code)
            # 改密码即令全部查看会话失效
            self._auth["view_sessions"] = {}
            self._save(self._auth_file, self._auth)

    def verify_view_password(self, code: str) -> bool:
        with self._lock:
            stored = self._auth.get("view_password_hash", "")
        return bool(stored) and _verify_password(code, stored)

    def view_locked_until(self) -> float:
        with self._lock:
            return float(self._auth.get("view_failures", {}).get("until", 0) or 0)

    def record_view_failure(self) -> None:
        with self._lock:
            failures = self._auth.setdefault("view_failures", {"count": 0, "until": 0})
            failures["count"] = int(failures.get("count", 0)) + 1
            if failures["count"] >= config.MAX_FAILED_LOGINS:
                failures["until"] = time.time() + config.LOCKOUT_SECONDS
                failures["count"] = 0
            self._save(self._auth_file, self._auth)

    def clear_view_failures(self) -> None:
        with self._lock:
            self._auth["view_failures"] = {"count": 0, "until": 0}
            self._save(self._auth_file, self._auth)

    def create_view_session(self) -> str:
        token = secrets.token_urlsafe(32)
        now = time.time()
        with self._lock:
            sessions = self._auth.setdefault("view_sessions", {})
            expired = [t for t, s in sessions.items()
                       if float(s.get("expires", 0)) < now]
            for t in expired:
                sessions.pop(t, None)
            sessions[token] = {"expires": now + config.VIEW_SESSION_TTL_SECONDS}
            self._save(self._auth_file, self._auth)
        return token

    def check_view_session(self, token: str | None) -> bool:
        if not token:
            return False
        now = time.time()
        with self._lock:
            session = self._auth.get("view_sessions", {}).get(token)
            return bool(session) and float(session.get("expires", 0)) >= now

    def clear_view_sessions(self) -> None:
        with self._lock:
            self._auth["view_sessions"] = {}
            self._save(self._auth_file, self._auth)
