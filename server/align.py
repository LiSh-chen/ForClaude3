"""Frame alignment: keep the road direction in the middle of every 1280x720 frame."""
import io
import math

import numpy as np
from PIL import Image

OW, OH = 1280, 720
_grid_cache = {}


def signed_diff(a, b):
    """a - b wrapped to (-180, 180]."""
    return (a - b + 540) % 360 - 180


def hfov_of(cam, iw, ih):
    """Horizontal FOV in degrees from Mapillary's normalised focal length, 70 if unknown."""
    f = cam[0] if cam else 0
    if f and f > 0:
        return math.degrees(2 * math.atan(0.5 * (iw / max(iw, ih)) / f))
    return 70.0


def _grid(hfov):
    if hfov not in _grid_cache:
        f = (OW / 2) / math.tan(math.radians(hfov) / 2)
        x = np.arange(OW, dtype=np.float32) + 0.5 - OW / 2
        y = OH / 2 - (np.arange(OH, dtype=np.float32) + 0.5)
        X, Y = np.meshgrid(x, y)
        _grid_cache[hfov] = (np.degrees(np.arctan2(X, f)), np.arctan2(Y, np.hypot(X, f)))
    return _grid_cache[hfov]


def reproject_pano(img, yaw_rel, hfov=80.0):
    """Perspective view out of an equirectangular panorama, looking yaw_rel degrees from its centre."""
    src = np.asarray(img.convert("RGB"), dtype=np.float32)
    sh, sw = src.shape[:2]
    dlon, lat = _grid(hfov)
    u = (dlon + yaw_rel) / 360 + 0.5
    u -= np.floor(u)
    fx = u * sw - 0.5
    fy = np.clip((0.5 - lat / np.pi) * sh - 0.5, 0, sh - 1.001)
    x0, y0 = np.floor(fx).astype(int), np.floor(fy).astype(int)
    tx, ty = (fx - x0)[..., None], (fy - y0)[..., None]
    xa = x0 % sw
    xb = (xa + 1) % sw
    top = src[y0, xa] * (1 - tx) + src[y0, xb] * tx
    bot = src[y0 + 1, xa] * (1 - tx) + src[y0 + 1, xb] * tx
    return Image.fromarray((top * (1 - ty) + bot * ty).clip(0, 255).astype(np.uint8))


def align_frame(data, meta, align=True):
    """JPEG/PNG bytes + candidate meta (ang, hd, pano, cam) -> 1280x720 RGB image."""
    img = Image.open(io.BytesIO(data)).convert("RGB")
    iw, ih = img.size
    if meta["pano"]:
        return reproject_pano(img, signed_diff(meta["hd"], meta["ang"] or 0.0))
    if align:
        s = max(OW / iw, OH / ih) * 1.12
        w, h = round(iw * s), round(ih * s)
        img = img.resize((w, h), Image.LANCZOS)
        ppd = w / hfov_of(meta.get("cam"), iw, ih)
        margin = (w - OW) / 2
        dx = max(-margin, min(margin, -signed_diff(meta["hd"], meta["ang"]) * ppd))  # yaw error -> shift
        left = max(0, min(w - OW, round((w - OW) / 2 - dx)))
        top = (h - OH) // 2
        return img.crop((left, top, left + OW, top + OH))
    s = min(OW / iw, OH / ih)
    img = img.resize((round(iw * s), round(ih * s)), Image.LANCZOS)
    out = Image.new("RGB", (OW, OH))
    out.paste(img, ((OW - img.width) // 2, (OH - img.height) // 2))
    return out
