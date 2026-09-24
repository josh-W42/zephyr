import io

import numpy as np
from PIL import Image


def _forward(a, vmin, vmax, encoding):
    if encoding == "linear":
        return a, vmin, vmax
    if encoding == "sqrt":
        if vmin < 0:
            raise ValueError("sqrt encoding needs vmin >= 0")
        return np.sqrt(np.maximum(a, 0)), np.sqrt(vmin), np.sqrt(vmax)
    raise ValueError(f"unknown encoding {encoding!r}")


def quantize(a: np.ndarray, vmin: float, vmax: float, encoding: str = "linear") -> np.ndarray:
    if not np.isfinite(a).all():
        raise ValueError("cannot quantize non-finite values")
    a, lo, hi = _forward(np.asarray(a, dtype=np.float64), vmin, vmax, encoding)
    if hi <= lo:
        return np.zeros(a.shape, np.uint8)
    return np.clip(np.rint((a - lo) / (hi - lo) * 255), 0, 255).astype(np.uint8)


def dequantize(q: np.ndarray, vmin: float, vmax: float, encoding: str = "linear") -> np.ndarray:
    _, lo, hi = _forward(np.zeros(1), vmin, vmax, encoding)
    x = lo + q.astype(np.float64) / 255 * (hi - lo)
    return x**2 if encoding == "sqrt" else x


def encode_png(channels: list[np.ndarray]) -> bytes:
    # Two channels go in RGB, not LA: browsers premultiply alpha on upload,
    # which would corrupt the V component wherever it is small.
    if len(channels) == 1:
        img = Image.fromarray(channels[0])
    elif len(channels) == 2:
        img = Image.fromarray(np.dstack([channels[0], channels[1], np.zeros_like(channels[0])]))
    else:
        raise ValueError("encode_png takes 1 or 2 channels")
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    return buf.getvalue()
