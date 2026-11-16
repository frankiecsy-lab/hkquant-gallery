"""視頻縮略圖：imageio-ffmpeg 抽取第一格畫面轉 JPEG（伺服器端快取）。

POC 實測（47.82.97.159 一次性容器 512m）：6.3MB MP4 抽幀 0.32 秒、
ffmpeg 子進程 peak RSS 73MB——1.6G 共享伺服器 Safe。全域最多 2 個並發抽取
（瀏覽器一頁最多 6 張視頻瓦片齊發，73MB×6 會搶記憶體，信號量壓到 2）。
"""

import subprocess
import threading

import imageio_ffmpeg

_SEM = threading.BoundedSemaphore(2)  # 並發上限；其餘請求排隊等（每張百毫秒級）
_TIMEOUT = 15                          # 單次抽幀超時（秒）：壞檔／怪格式不掛線程


def _quiet_unlink(path) -> None:
    try:
        path.unlink()
    except OSError:
        pass


def make(src, out, max_side: int, quality: int) -> bool:
    """src 視頻路徑 → out JPEG 縮略圖；失敗回傳 False（前端保留 ▶ 瓦片降級）。"""
    from PIL import Image  # 延後導入：與 scanner 共用 Pillow

    exe = imageio_ffmpeg.get_ffmpeg_exe()
    vf = f"scale={max_side}:{max_side}:force_original_aspect_ratio=decrease"
    tmp = out.with_name(out.name + ".tmp.png")
    out.parent.mkdir(parents=True, exist_ok=True)  # 首次部署目錄未建立時兜底
    with _SEM:
        # 先搵 1 秒位置（避開黑場開場）；太短嘅視頻再試 0 秒
        for seek in ("1", "0"):
            ok = False
            try:
                r = subprocess.run(
                    [exe, "-ss", seek, "-i", str(src), "-frames:v", "1",
                     "-vf", vf, "-y", str(tmp)],
                    capture_output=True, timeout=_TIMEOUT)
            except subprocess.TimeoutExpired:
                _quiet_unlink(tmp)
                break  # 超時即放棄，唔好再試
            if r.returncode == 0 and tmp.is_file() and tmp.stat().st_size > 0:
                try:
                    with Image.open(tmp) as im:
                        im.convert("RGB").save(out, "JPEG", quality=quality)
                    ok = True
                except Exception:  # noqa: BLE001  PNG 損壞等當失敗處理
                    ok = False
            _quiet_unlink(tmp)
            if ok:
                return True
    return False
