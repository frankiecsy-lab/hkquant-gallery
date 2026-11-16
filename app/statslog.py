"""訪問統計：依 User-Agent 分類設備／瀏覽器，按日匯總＋最近事件環形緩衝。

以 JSON 原子寫入（與 store.py 同類策略）；單次拜訪以訪客識別 5 分鐘窗口去重，
避免頁腳每 60 秒自動刷新把計數灌水。所有操作在記憶體改＋落盤，規模常數級
（日誌環形緩衝上限 MAX_LOG 條），1.6G 伺服器零壓力。
"""

import json
import os
import re
import threading
import time
from pathlib import Path

MAX_LOG = 300          # 最近事件保留條數
THROTTLE_SECONDS = 300  # 同一訪客 5 分鐘內只記一次
DAYS_KEEP = 60         # 按日匯總保留天數（快照只展最近 14 天，多餘留待自然滾出）

_BOT_RE = re.compile(r"bot|crawl|spider|curl|python-requests|wget|headless|okhttp|java/", re.I)


def classify(ua: str) -> tuple[str, str]:
    """(設備級別, 標籤)。設備級別＝mobile/tablet/desktop/bot；標籤＝系統·瀏覽器。"""
    ua = ua or ""
    if _BOT_RE.search(ua):
        return "bot", "機械人"
    if re.search(r"iPhone|iPod", ua):
        dev, os_name = "mobile", "iOS"
    elif "iPad" in ua or ("Android" in ua and "Mobile" not in ua):
        dev, os_name = "tablet", "iPad" if "iPad" in ua else "Android"
    elif re.search(r"Mobile|Android", ua):
        dev, os_name = "mobile", "Android"
    elif "Windows" in ua:
        dev, os_name = "desktop", "Windows"
    elif re.search(r"Mac OS X|Macintosh", ua):
        dev, os_name = "desktop", "macOS"
    elif "Linux" in ua or "X11" in ua:
        dev, os_name = "desktop", "Linux"
    else:
        dev, os_name = "desktop", "其他"
    if re.search(r"Edg/|Edge/", ua):
        browser = "Edge"
    elif "OPR/" in ua or "Opera" in ua:
        browser = "Opera"
    elif re.search(r"Firefox|FxiOS", ua):
        browser = "Firefox"
    elif "Chrome" in ua or "CriOS" in ua:
        browser = "Chrome"
    elif re.search(r"Safari|Version/", ua):
        browser = "Safari"
    else:
        browser = "瀏覽器?"
    return dev, f"{os_name}·{browser}"


class StatsLog:
    """線程安全的訪問統計存儲（days/labels/log 三段）。"""

    def __init__(self, path: Path):
        self._path = Path(path)
        self._lock = threading.Lock()
        self._last_seen: dict[str, float] = {}
        self._data = self._empty()
        self._load()

    @staticmethod
    def _empty() -> dict:
        return {
            "started": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "total": 0,
            "days": {},     # {"YYYY-MM-DD": {"total":n,"mobile":n,"tablet":n,"desktop":n,"bot":n}}
            "labels": {},   # {"Android·Chrome": n}
            "log": [],      # [{"ts","dev","label"}] 新在前，上限 MAX_LOG
        }

    def _load(self) -> None:
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
            if isinstance(raw, dict) and isinstance(raw.get("days"), dict):
                self._data = {**self._empty(), **raw}
        except (OSError, ValueError):
            pass  # 缺檔／損壞即用空表重建（首次寫入時生成）

    def _save_locked(self) -> None:
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self._data, ensure_ascii=False), encoding="utf-8")
            os.replace(tmp, self._path)
        except OSError:
            pass  # 統計屬旁支功能，落盤失敗不影響主流程

    def record(self, ua: str, visitor: str) -> None:
        """記錄一次拜訪；同一訪客 5 分鐘窗口去重（visitor 為會話令牌或客戶端 IP）。"""
        now = time.time()
        last = self._last_seen.get(visitor)
        if last is not None and now - last < THROTTLE_SECONDS:
            return
        self._last_seen[visitor] = now
        if len(self._last_seen) > 5000:  # 防記憶體無界增長
            self._last_seen.clear()
            self._last_seen[visitor] = now
        dev, label = classify(ua)
        with self._lock:
            day = time.strftime("%Y-%m-%d")
            d = self._data["days"].setdefault(
                day, {"total": 0, "mobile": 0, "tablet": 0, "desktop": 0, "bot": 0})
            d["total"] += 1
            d[dev] = d.get(dev, 0) + 1
            self._data["labels"][label] = self._data["labels"].get(label, 0) + 1
            self._data["total"] += 1
            self._data["log"].insert(0, {
                "ts": time.strftime("%Y-%m-%d %H:%M:%S"), "dev": dev, "label": label})
            del self._data["log"][MAX_LOG:]
            days = self._data["days"]
            if len(days) > DAYS_KEEP:  # 舊日期滾出（按字串序即時間序）
                for old in sorted(days)[:-DAYS_KEEP]:
                    days.pop(old, None)
            self._save_locked()

    def snapshot(self) -> dict:
        with self._lock:
            days = self._data["days"]
            recent = sorted(days)[-14:]
            return {
                "total": self._data["total"],
                "started": self._data.get("started", ""),
                "days": [{"date": k, **days[k]} for k in recent],
                "labels": dict(sorted(self._data["labels"].items(),
                                      key=lambda kv: -kv[1])[:20]),
                "log": self._data["log"][:80],
            }

    def reset(self) -> None:
        with self._lock:
            self._data = self._empty()
            self._save_locked()
