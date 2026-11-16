"""人脸检索核心：buffalo_sc 模型（SCRFD-500M 检测＋w600k_mbf 512 维识别）。

纯 onnxruntime＋numpy＋Pillow 实现（无 OpenCV／insightface 依赖树）。
1.6G 内存服务器的约束设计：
- 模型惰性加载（未用过完全不占内存）＋闲置自动卸载（看门狗线程）；
- 单线程推理（intra_op_num_threads=1，防止 CPU 打满影响其他服务）；
- 后台索引线程按 FACES_INDEX_INTERVAL 节流（默认 1.5 秒/张）；
- 索引 JSON（data/faces.json）按 size|mtime 增量，向量以 base64(float32) 存储。
模型文件缺失时抛 FaceUnavailable，由 API 层转 503 友好降级。
"""
import base64
import json
import os
import threading
import time
from pathlib import Path

import numpy as np
from PIL import Image

from . import config

DET_SIZE = 640
STRIDES = (8, 16, 32)
DET_THRESH = 0.5
NMS_IOU = 0.4
MAX_FACES_PER_IMAGE = 20
# ArcFace 标准 5 点参考坐标（112x112 模板）
TEMPLATE = np.array([[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366],
                     [41.5493, 92.3655], [70.7299, 92.2041]], dtype=np.float32)
# 解码前 draft 降采样的触发阈值与目标（与 /thumb 同策略，控制峰值内存）
DRAFT_TRIGGER = 1600
DRAFT_TARGET = (1280, 1280)


class FaceUnavailable(Exception):
    """模型文件缺失或会话初始化失败：上层应返回 503 并提示未启用。"""


# ---------- 模型会话（惰性加载＋闲置卸载） ----------

_state_lock = threading.Lock()
_sessions: tuple | None = None  # (det_session, rec_session)
_last_use = 0.0
_watchdog: threading.Thread | None = None


def sessions_loaded() -> bool:
    with _state_lock:
        return _sessions is not None


def models_available() -> bool:
    det = config.FACES_MODEL_DIR / "det_500m.onnx"
    rec = config.FACES_MODEL_DIR / "w600k_mbf.onnx"
    return det.is_file() and rec.is_file()


def _load_sessions():
    """加载两个 ONNX 会话（单线程，避免抢占共享服务器 CPU）。"""
    import onnxruntime as ort  # 延迟导入：未配置模型时不触碰该库

    opts = ort.SessionOptions()
    opts.intra_op_num_threads = 1
    opts.inter_op_num_threads = 1
    det = ort.InferenceSession(str(config.FACES_MODEL_DIR / "det_500m.onnx"),
                               sess_options=opts, providers=["CPUExecutionProvider"])
    rec = ort.InferenceSession(str(config.FACES_MODEL_DIR / "w600k_mbf.onnx"),
                               sess_options=opts, providers=["CPUExecutionProvider"])
    return det, rec


def _ensure_sessions():
    """获取（必要时加载）会话对；并发首载由锁保证单飞。"""
    global _sessions, _last_use, _watchdog
    with _state_lock:
        if _sessions is None:
            if not models_available():
                raise FaceUnavailable("模型文件缺失")
            try:
                _sessions = _load_sessions()
            except Exception as exc:  # noqa: BLE001
                raise FaceUnavailable(f"模型加载失败：{exc}") from exc
            if config.FACES_IDLE_UNLOAD_SECONDS > 0 and (
                    _watchdog is None or not _watchdog.is_alive()):
                _watchdog = threading.Thread(target=_watchdog_loop, daemon=True)
                _watchdog.start()
        _last_use = time.time()
        return _sessions


def _watchdog_loop():
    """闲置超过 FACES_IDLE_UNLOAD_SECONDS 且索引未运行时释放会话，回收约 200MB。"""
    global _sessions, _watchdog
    while True:
        time.sleep(30)
        with _state_lock:
            if _sessions is None:
                _watchdog = None
                return
            idle = time.time() - _last_use
            if (config.FACES_IDLE_UNLOAD_SECONDS > 0
                    and idle > config.FACES_IDLE_UNLOAD_SECONDS
                    and not _index_state["running"]):
                _sessions = None
                return


# ---------- 检测与识别（自 POC 移植，逻辑一致） ----------

def _letterbox(img: Image.Image):
    """RGB PIL → 640x640 float32（(x-127.5)/127.5），返回 (blob, scale, pad_x, pad_y)。"""
    w, h = img.size
    scale = min(DET_SIZE / w, DET_SIZE / h)
    nw, nh = int(w * scale), int(h * scale)
    resized = img.resize((nw, nh), Image.BILINEAR).convert("RGB")
    canvas = np.full((DET_SIZE, DET_SIZE, 3), 127.5, dtype=np.float32)
    pad_x, pad_y = (DET_SIZE - nw) // 2, (DET_SIZE - nh) // 2
    canvas[pad_y:pad_y + nh, pad_x:pad_x + nw] = np.asarray(resized, dtype=np.float32)
    blob = ((canvas - 127.5) / 127.5).transpose(2, 0, 1)[None]
    return np.ascontiguousarray(blob), scale, pad_x, pad_y


def _iou(a, arr):
    x1 = np.maximum(a[0], arr[:, 0])
    y1 = np.maximum(a[1], arr[:, 1])
    x2 = np.minimum(a[2], arr[:, 2])
    y2 = np.minimum(a[3], arr[:, 3])
    inter = np.clip(x2 - x1, 0, None) * np.clip(y2 - y1, 0, None)
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (arr[:, 2] - arr[:, 0]) * (arr[:, 3] - arr[:, 1]) - inter
    return inter / np.clip(ua, 1e-6, None)


def _det_decode(outs, scale, pad_x, pad_y):
    """SCRFD anchor 解码：outs＝3 stride × (score, dis, kps)，2 anchors/位置。"""
    boxes, scores, kpss = [], [], []
    for stride, s_out, d_out, k_out in zip(STRIDES, outs[0:3], outs[3:6], outs[6:9]):
        grid = DET_SIZE // stride
        n_anchors = s_out.shape[0] // (grid * grid)
        keep = np.nonzero(s_out[:, 0] > DET_THRESH)[0]
        if keep.size == 0:
            continue
        rows = keep // (grid * n_anchors)
        cols = (keep % (grid * n_anchors)) // n_anchors
        cx = cols * stride + 0.5 * stride
        cy = rows * stride + 0.5 * stride
        d = d_out[keep] * stride
        b = np.stack([cx - d[:, 0], cy - d[:, 1], cx + d[:, 2], cy + d[:, 3]], axis=1)
        k = k_out[keep].reshape(-1, 5, 2) * stride + np.stack([cx, cy], axis=1)[:, None, :]
        # 还原 letterbox 到原图坐标
        b = (b - [pad_x, pad_y, pad_x, pad_y]) / scale
        k = (k - [pad_x, pad_y]) / scale
        boxes.append(b)
        scores.append(s_out[keep, 0])
        kpss.append(k)
    if not boxes:
        return []
    boxes = np.concatenate(boxes)
    scores = np.concatenate(scores)
    kpss = np.concatenate(kpss)
    order = np.argsort(-scores)
    boxes, kpss, scores = boxes[order], kpss[order], scores[order]
    kept = []
    while boxes.shape[0] and len(kept) < MAX_FACES_PER_IMAGE:
        kept.append((boxes[0], scores[0], kpss[0]))
        if boxes.shape[0] == 1:
            break
        rest = np.nonzero(_iou(boxes[0], boxes[1:]) < NMS_IOU)[0] + 1
        boxes, scores, kpss = boxes[rest], scores[rest], kpss[rest]
    return kept


def _similarity_transform(src, dst):
    """最小二乘解 4 参数相似变换（s·cosθ, s·sinθ, tx, ty）：src→dst（5 点 2D）。"""
    n = src.shape[0]
    A = np.zeros((2 * n, 4), dtype=np.float64)
    b = np.zeros(2 * n, dtype=np.float64)
    A[0::2] = np.stack([src[:, 0], -src[:, 1], np.ones(n), np.zeros(n)], axis=1)
    A[1::2] = np.stack([src[:, 1], src[:, 0], np.zeros(n), np.ones(n)], axis=1)
    b[0::2] = dst[:, 0]
    b[1::2] = dst[:, 1]
    sol, *_ = np.linalg.lstsq(A, b, rcond=None)
    a_, b_, tx, ty = sol
    return np.array([[a_, -b_, tx], [b_, a_, ty]], dtype=np.float32)


def _align_and_embed(img: Image.Image, kps, rec_session) -> np.ndarray:
    """由原图＋5 点抽 112x112 对齐脸（PIL affine）→ 归一化 → L2 归一向量。"""
    m = _similarity_transform(kps.astype(np.float64), TEMPLATE.astype(np.float64))
    inv = np.linalg.inv(np.vstack([m, [0, 0, 1]])).astype(np.float32)
    face = img.transform((112, 112), Image.AFFINE, inv[:2].flatten().tolist(),
                         resample=Image.BILINEAR)
    arr = (np.asarray(face.convert("RGB"), dtype=np.float32) - 127.5) / 127.5
    blob = np.ascontiguousarray(arr.transpose(2, 0, 1)[None])
    emb = rec_session.run(None, {rec_session.get_inputs()[0].name: blob})[0][0]
    return emb / np.linalg.norm(emb)


def _open_rgb(data: bytes) -> Image.Image:
    import io
    img = Image.open(io.BytesIO(data))
    if max(img.size) > DRAFT_TRIGGER:
        img.draft("RGB", DRAFT_TARGET)  # 先降采样再解码，控制大图峰值内存
    img.load()
    return img.convert("RGB")


def embed_image(img: Image.Image) -> list[np.ndarray]:
    """对 RGB 图像提取全部人脸向量（无人脸返回空列表）。"""
    det, rec = _ensure_sessions()
    blob, scale, px, py = _letterbox(img)
    outs = det.run(None, {det.get_inputs()[0].name: blob})
    faces = _det_decode(outs, scale, px, py)
    return [_align_and_embed(img, kps, rec) for (_b, _s, kps) in faces]


def embed_bytes(data: bytes) -> list[np.ndarray]:
    return embed_image(_open_rgb(data))


def embed_file(path: Path) -> list[np.ndarray]:
    with Image.open(path) as raw:
        if max(raw.size) > DRAFT_TRIGGER:
            raw.draft("RGB", DRAFT_TARGET)
        raw.load()
        img = raw.convert("RGB")
    return embed_image(img)


# ---------- 索引存储（data/faces.json，原子写） ----------

_db_lock = threading.Lock()
_db: dict | None = None  # key -> {"f": 指纹, "e": [base64(float32), ...]}


def _db_path() -> Path:
    return config.FACES_DB


def _load_db_locked() -> dict:
    global _db
    if _db is not None:
        return _db
    path = _db_path()
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        _db = data if isinstance(data, dict) else {}
    except (FileNotFoundError, ValueError, OSError):
        _db = {}  # 损坏或缺失：重建（不备份旧档，索引可全量重算）
    return _db


def _save_db_locked(db: dict) -> None:
    path = _db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(db, fh, separators=(",", ":"))
    os.replace(tmp, path)


def _emb_to_b64(emb: np.ndarray) -> str:
    return base64.b64encode(emb.astype(np.float32).tobytes()).decode("ascii")


def _b64_to_emb(text: str) -> np.ndarray:
    return np.frombuffer(base64.b64decode(text), dtype=np.float32)


def fingerprint(size: int, mtime_iso: str) -> str:
    return f"{size}|{mtime_iso}"


def indexed_keys() -> dict[str, str]:
    """返回 {key: 指纹}，供增量比对。"""
    with _db_lock:
        return {k: v.get("f", "") for k, v in _load_db_locked().items()}


def prune(stale_keys: set[str]) -> int:
    """删除已不存在文件的索引项，返回删除数。"""
    with _db_lock:
        db = _load_db_locked()
        removed = [k for k in stale_keys if k in db]
        for k in removed:
            del db[k]
        if removed:
            _save_db_locked(db)
        return len(removed)


# ---------- 后台索引（单线程节流） ----------

_index_lock = threading.Lock()
_index_state = {"running": False, "done": 0, "todo": 0, "errors": 0}


def index_state() -> dict:
    with _index_lock:
        return dict(_index_state)


def pending_count(entries: list[dict]) -> int:
    """entries: [{"key","path","size","mtime"}]，返回指纹有变化或新增的张数。"""
    known = indexed_keys()
    return sum(1 for e in entries
               if known.get(e["key"]) != fingerprint(e["size"], e["mtime"]))


def start_index(entries: list[dict]) -> bool:
    """有增量才启动后台索引线程；已在运行则直接返回 False（单飞）。"""
    todo = [e for e in entries
            if indexed_keys().get(e["key"]) != fingerprint(e["size"], e["mtime"])]
    if not todo:
        # 无增量也顺带清理失效项（文件被删/改名）
        prune(set(indexed_keys()) - {e["key"] for e in entries})
        return False
    with _index_lock:
        if _index_state["running"]:
            return False
        _index_state.update(running=True, done=0, todo=len(todo), errors=0)
    threading.Thread(target=_index_worker, args=(todo, entries), daemon=True).start()
    return True


def _index_worker(todo: list[dict], entries: list[dict]) -> None:
    global _index_state
    try:
        for i, e in enumerate(todo):
            try:
                embs = embed_file(config.FTP_ROOT / e["key"])
                with _db_lock:
                    db = _load_db_locked()
                    db[e["key"]] = {"f": fingerprint(e["size"], e["mtime"]),
                                    "e": [_emb_to_b64(v) for v in embs]}
                    if (i + 1) % 10 == 0:
                        _save_db_locked(db)
            except FaceUnavailable:
                break  # 模型中途不可用：停止并落盘已完成部分
            except Exception:  # noqa: BLE001  单张损坏不拖垮整轮索引
                with _index_lock:
                    _index_state["errors"] += 1
            with _index_lock:
                _index_state["done"] += 1
            if i + 1 < len(todo):
                time.sleep(config.FACES_INDEX_INTERVAL)
        with _db_lock:
            _save_db_locked(_load_db_locked())
        prune(set(indexed_keys()) - {e["key"] for e in entries})
    finally:
        with _index_lock:
            _index_state["running"] = False


# ---------- 检索 ----------

def search(embeddings: list[np.ndarray], threshold: float,
           allow_keys: set[str] | None = None, limit: int = 500) -> list[dict]:
    """与全库比对：每张图取最大余弦相似度；返回 [{"key","sim"}] 降序。

    allow_keys 提供时只在该集合内匹配（隐藏照片／不可见资料夹过滤在 API 层做）。
    """
    if not embeddings:
        return []
    q = np.stack(embeddings)  # (m,512)，均已 L2 归一
    results = []
    with _db_lock:
        db = dict(_load_db_locked())
    for key, item in db.items():
        if allow_keys is not None and key not in allow_keys:
            continue
        try:
            cand = np.stack([_b64_to_emb(v) for v in item.get("e", [])])
        except Exception:  # noqa: BLE001  坏条目跳过
            continue
        if cand.size == 0:
            continue
        best = float((cand @ q.T).max())
        if best >= threshold:
            results.append({"key": key, "sim": best})
    results.sort(key=lambda r: -r["sim"])
    return results[:limit]


def indexed_count() -> int:
    with _db_lock:
        return len(_load_db_locked())
