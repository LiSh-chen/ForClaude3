"""Frame alignment: keep the road direction in the middle of every 1280x720 frame."""
import glob
import io
import math
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFont

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


def align_frame_view(data, meta, align=True):
    """Like align_frame, but also returns the camera model of the finished frame:
    {cx, cy: optical-axis pixel, f: focal length in px, heading: compass heading of the axis}."""
    img = Image.open(io.BytesIO(data)).convert("RGB")
    iw, ih = img.size
    if meta["pano"]:
        out = reproject_pano(img, signed_diff(meta["hd"], meta["ang"] or 0.0))
        return out, {"cx": OW / 2, "cy": OH / 2, "f": (OW / 2) / math.tan(math.radians(80) / 2), "heading": meta["hd"]}
    hf = hfov_of(meta.get("cam"), iw, ih)
    if align:
        s = max(OW / iw, OH / ih) * 1.12
        w, h = round(iw * s), round(ih * s)
        img = img.resize((w, h), Image.LANCZOS)
        ppd = w / hf
        margin = (w - OW) / 2
        dx = max(-margin, min(margin, -signed_diff(meta["hd"], meta["ang"]) * ppd))  # yaw error -> shift
        left = max(0, min(w - OW, round((w - OW) / 2 - dx)))
        top = (h - OH) // 2
        view = {"cx": OW / 2 + ((w - OW) / 2 - left), "cy": OH / 2, "f": (w / 2) / math.tan(math.radians(hf) / 2),
                "heading": meta["ang"]}
        return img.crop((left, top, left + OW, top + OH)), view
    s = min(OW / iw, OH / ih)
    img = img.resize((round(iw * s), round(ih * s)), Image.LANCZOS)
    out = Image.new("RGB", (OW, OH))
    out.paste(img, ((OW - img.width) // 2, (OH - img.height) // 2))
    return out, {"cx": OW / 2, "cy": OH / 2, "f": (img.width / 2) / math.tan(math.radians(hf) / 2), "heading": meta["ang"]}


def align_frame(data, meta, align=True):
    """JPEG/PNG bytes + candidate meta (ang, hd, pano, cam) -> 1280x720 RGB image."""
    return align_frame_view(data, meta, align)[0]


# ---------- direction cues drawn onto the frame ----------
DIR_ZH = {"left": "左轉", "right": "右轉", "slight left": "靠左", "slight right": "靠右", "sharp left": "大角度左轉",
          "sharp right": "大角度右轉", "uturn": "迴轉", "straight": "直行"}
DIR_EN = {"left": "Turn left", "right": "Turn right", "slight left": "Bear left", "slight right": "Bear right",
          "sharp left": "Sharp left", "sharp right": "Sharp right", "uturn": "U-turn", "straight": "Continue straight"}
DIR_ANGLE = {"left": -90, "right": 90, "slight left": -40, "slight right": 40, "sharp left": -135,
             "sharp right": 135, "uturn": 180, "straight": 0}
_FONT_GLOBS = [
    "/usr/share/fonts/**/NotoSansCJK*", "/usr/share/fonts/**/NotoSansTC*", "/usr/share/fonts/**/wqy-*",
    "/usr/share/fonts/**/DroidSansFallback*", "/usr/share/fonts/**/NotoSerifCJK*",
    "/System/Library/Fonts/PingFang*", "/System/Library/Fonts/STHeiti*", "C:/Windows/Fonts/msjh*.tt*",
]
_font_path = False


def find_cjk_font():
    """Path of a font that can draw Chinese (SV_FONT overrides), or None."""
    global _font_path
    if _font_path is False:
        cands = [os.environ.get("SV_FONT", "")]
        for g in _FONT_GLOBS:
            cands += sorted(glob.glob(g, recursive=True))
        _font_path = next((c for c in cands if c and os.path.isfile(c)), None)
    return _font_path


def _side(mod):
    return "left" if "left" in mod else "right" if "right" in mod else ""


def cue_text(cue, zh=True):
    """(line 1, line 2) of the banner. zh=False gives English (used when no Chinese font is installed)."""
    typ, mod, ex = cue["type"], cue.get("mod") or "", cue.get("exit") or 0
    side = _side(mod)
    if zh:
        sd = {"left": "左", "right": "右"}.get(side, "")
        if typ in ("roundabout", "rotary"):
            phrase = f"進入圓環，第 {ex} 個出口" if ex else "進入圓環"
        elif typ in ("exit roundabout", "exit rotary"):
            phrase = "駛出圓環"
        elif typ == "fork":
            phrase = f"叉路靠{sd}" if sd else "叉路"
        elif typ == "end of road":
            phrase = f"路底{DIR_ZH.get(mod, '轉彎')}" if sd else "路底轉彎"
        elif typ == "on ramp":
            phrase = f"上匝道（靠{sd}）" if sd else "上匝道"
        elif typ in ("off ramp", "exit"):
            phrase = f"下匝道（靠{sd}）" if sd else "下匝道"
        elif typ == "merge":
            phrase = f"匯入（靠{sd}）" if sd else "匯入車道"
        else:
            phrase = DIR_ZH.get(mod, "直行")
        l1 = f"{cue['dist']} 公尺後 {phrase}" if cue["dist"] else phrase
        l2 = f"進入 {cue['name']}" if cue.get("name") else ""
        return l1, l2
    if typ in ("roundabout", "rotary"):
        phrase = f"Roundabout, exit {ex}" if ex else "Roundabout"
    elif typ in ("exit roundabout", "exit rotary"):
        phrase = "Leave the roundabout"
    elif typ == "fork":
        phrase = f"Keep {side} at the fork" if side else "Fork"
    elif typ == "end of road":
        phrase = f"End of road, {DIR_EN.get(mod, 'turn').lower()}"
    elif typ == "on ramp":
        phrase = "Take the ramp"
    elif typ in ("off ramp", "exit"):
        phrase = "Take the exit"
    elif typ == "merge":
        phrase = f"Merge {side}" if side else "Merge"
    else:
        phrase = DIR_EN.get(mod, "Continue straight")
    l1 = f"In {cue['dist']} m: {phrase}" if cue["dist"] else phrase
    name = cue.get("name") or ""
    return l1, (f"onto {name}" if name and name.isascii() else "")


def _font(path, size):
    return ImageFont.truetype(path, size) if path else ImageFont.load_default(size)


def draw_cue(img, cue):
    """Banner at the top of a 1280x720 frame: arrow, '50 公尺後 右轉', and the road being entered. In place."""
    path = find_cjk_font()
    l1, l2 = cue_text(cue, zh=bool(path))
    big, small = 40, 28
    meas = ImageDraw.Draw(img)
    while True:   # shrink long road names until the banner fits
        f1, f2 = _font(path, big), _font(path, small)
        tw = max(meas.textlength(l1, font=f1), meas.textlength(l2, font=f2) if l2 else 0)
        if tw + 150 <= OW - 40 or big <= 20:
            break
        big, small = big - 2, max(14, small - 2)
    bw, bh = int(tw + 150), 112 if l2 else 84
    x, y = (OW - bw) // 2, 24
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.rounded_rectangle([x, y, x + bw, y + bh], radius=18, fill=(15, 20, 28, 204))
    cx, cy, size = x + 56, y + bh // 2, 56.0
    if cue.get("type") in ("roundabout", "rotary"):
        r = size * 0.6
        d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(255, 255, 255, 255), width=max(2, round(size * 0.09)))
        size *= 0.8
    th = math.radians(DIR_ANGLE.get(cue.get("mod") or "", 0))
    pts = [(0, -.5), (.38, -.05), (.14, -.05), (.14, .5), (-.14, .5), (-.14, -.05), (-.38, -.05)]
    d.polygon([(cx + (px * math.cos(th) - py * math.sin(th)) * size, cy + (px * math.sin(th) + py * math.cos(th)) * size)
               for px, py in pts], fill=(255, 255, 255, 255))
    d.text((x + 110, y + (38 if l2 else bh // 2)), l1, font=f1, fill=(255, 255, 255, 255), anchor="lm", stroke_width=1,
           stroke_fill=(255, 255, 255, 255))
    if l2:
        d.text((x + 110, y + 80), l2, font=f2, fill=(214, 219, 227, 255), anchor="lm")
    img.paste(Image.alpha_composite(img.convert("RGBA"), layer).convert("RGB"))


# ---------- marking the road to take: the route ahead, projected onto the frame ----------
CAM_H, LANE_HALF_W = 1.6, 1.3


def _bearing(a, b):
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dl = math.radians(b[1] - a[1])
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def _dist(a, b):
    dp, dl = math.radians(b[0] - a[0]), math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(math.radians(a[0])) * math.cos(math.radians(b[0])) * math.sin(dl / 2) ** 2
    return 2 * 6371000.0 * math.asin(math.sqrt(h))


def guide_shape(view, lat, lon, ahead):
    """Ground-plane projection (level pinhole camera CAM_H above the road) of a ribbon along `ahead`
    [(lat, lon)...]. Returns {"L", "R", "C"} pixel lists, or None if too little of it is visible."""
    g = []
    for p in ahead:
        d = _dist((lat, lon), p)
        rel = math.radians(signed_diff(_bearing((lat, lon), p), view["heading"]))
        X, Z = d * math.sin(rel), d * math.cos(rel)
        if Z >= 3:
            g.append((X, Z))
    if len(g) < 2:
        return None

    def proj(X, Z):
        return (view["cx"] + view["f"] * X / Z, view["cy"] + view["f"] * CAM_H / Z)

    L, R, C = [], [], []
    for i, (X, Z) in enumerate(g):
        a, b = g[max(0, i - 3)], g[min(len(g) - 1, i + 3)]   # wide window: no kink at a fork
        dx, dz = b[0] - a[0], b[1] - a[1]
        n = math.hypot(dx, dz) or 1.0
        dx, dz = dx / n, dz / n
        nx, nz = -dz * LANE_HALF_W, dx * LANE_HALF_W            # left-hand normal on the ground
        if Z - nz < 1 or Z + nz < 1:
            continue
        c = proj(X, Z)
        if c[0] < OW * 0.04 or c[0] > OW * 0.96:                # stop where the path leaves the frame
            break
        L.append(proj(X + nx, Z + nz))
        R.append(proj(X - nx, Z - nz))
        C.append(c)
    return {"L": L, "R": R, "C": C} if len(C) >= 2 else None


def junction_state(view, lat, lon, pt):
    """Where the junction is relative to this frame: 'in' = inside the picture, 'left' / 'right' = ahead but outside it,
    None = too far ahead or already behind the camera (nothing to point at)."""
    d = _dist((lat, lon), pt)
    rel = math.radians(signed_diff(_bearing((lat, lon), pt), view["heading"]))
    X, Z = d * math.sin(rel), d * math.cos(rel)
    if Z < 3 or Z > 90:
        return None
    x = view["cx"] + view["f"] * X / Z
    return "left" if x < OW * 0.06 else "right" if x > OW * 0.94 else "in"


def draw_edge_hint(img, side):
    """'◀ 路口在左側' pill on the edge where the junction lies, for when the road itself is outside the picture."""
    path = find_cjk_font()
    if path:
        label = "◀ 路口在左側" if side == "left" else "路口在右側 ▶"
    else:
        label = "◀ Junction on the left" if side == "left" else "Junction on the right ▶"
    font = _font(path, 30)
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    w = d.textlength(label, font=font) + 32
    x, y = (0 if side == "left" else OW - w), OH * 0.5
    d.rounded_rectangle([x, y, x + w, y + 50], radius=25, fill=(245, 158, 11, 235))
    d.text((x + 16, y + 26), label, font=font, fill=(31, 41, 55, 255), anchor="lm")
    img.paste(Image.alpha_composite(img.convert("RGBA"), layer).convert("RGB"))


def draw_guide(img, view, lat, lon, ahead, cue):
    """Marks the way on the frame (in place) -- but only where the junction is actually in the picture. When it is not,
    a path would land on pixels without a road, so just point to the side it is on."""
    state = junction_state(view, lat, lon, cue["pt"])
    if state is None:
        return
    if state != "in":
        return draw_edge_hint(img, state)
    sh = guide_shape(view, lat, lon, ahead)
    if not sh:
        return
    layer = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    poly = sh["L"] + sh["R"][::-1]
    d.polygon(poly, fill=(34, 197, 94, 128))
    d.line(poly + [poly[0]], fill=(255, 255, 255, 230), width=3, joint="curve")
    n = len(sh["C"])
    tx, ty = sh["C"][-1]
    px, py = sh["C"][max(0, n - 4)]
    ang = math.atan2(ty - py, tx - px)
    wid = min(48.0, max(16.0, math.hypot(sh["L"][-1][0] - sh["R"][-1][0], sh["L"][-1][1] - sh["R"][-1][1]) * 1.6))
    tri = [(wid * 1.2, 0), (-wid * 0.3, -wid * 0.8), (-wid * 0.3, wid * 0.8)]
    tri = [(tx + x * math.cos(ang) - y * math.sin(ang), ty + x * math.sin(ang) + y * math.cos(ang)) for x, y in tri]
    d.polygon(tri, fill=(22, 163, 74, 255))
    d.line(tri + [tri[0]], fill=(255, 255, 255, 255), width=3, joint="curve")
    path = find_cjk_font()
    label = "走這條" if path else "This way"
    font = _font(path, 30)
    w = d.textlength(label, font=font) + 28
    lx = min(OW - w - 10, max(10, tx - w / 2))
    ly = min(OH - 60, max(150, ty - 70))
    d.rounded_rectangle([lx, ly, lx + w, ly + 46], radius=23, fill=(22, 163, 74, 255), outline=(255, 255, 255, 255), width=3)
    d.text((lx + 14, ly + 24), label, font=font, fill=(255, 255, 255, 255), anchor="lm")
    img.paste(Image.alpha_composite(img.convert("RGBA"), layer).convert("RGB"))
