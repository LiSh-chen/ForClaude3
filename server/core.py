"""Core pipeline: route -> sample points -> Mapillary frames -> mp4."""
import math
import shutil
import subprocess
import time
from pathlib import Path

import requests

import align as aligner

OSRM = "https://routing.openstreetmap.de/{}/route/v1/driving"
ROUTERS = {"driving": "routed-car", "cycling": "routed-bike", "walking": "routed-foot"}
GRAPH = "https://graph.mapillary.com/images"
NOMINATIM = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "streetview-video/0.1 (personal use)"


class Cancelled(Exception):
    pass


class PipelineError(Exception):
    pass


def haversine(a, b):
    r = 6371000.0
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp, dl = p2 - p1, math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def bearing(a, b):
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dl = math.radians(b[1] - a[1])
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def angle_diff(a, b):
    d = abs(a - b) % 360
    return min(d, 360 - d)


def geocode(query, limit=5):
    r = requests.get(
        NOMINATIM,
        params={"q": query, "format": "json", "limit": limit},
        headers={"User-Agent": USER_AGENT},
        timeout=15,
    )
    r.raise_for_status()
    return [
        {"name": x["display_name"], "lat": float(x["lat"]), "lon": float(x["lon"])}
        for x in r.json()
    ]


def get_route(start, end, profile="driving"):
    """Return (polyline [(lat, lon)], distance_m)."""
    if profile not in ("driving", "walking", "cycling"):
        raise PipelineError(f"unknown profile: {profile}")
    url = f"{OSRM.format(ROUTERS[profile])}/{start[1]},{start[0]};{end[1]},{end[0]}"
    try:
        r = requests.get(
            url,
            params={"overview": "full", "geometries": "geojson"},
            headers={"User-Agent": USER_AGENT},
            timeout=30,
        )
        r.raise_for_status()
    except requests.RequestException as e:
        raise PipelineError(f"routing failed: {e}") from e
    data = r.json()
    if data.get("code") != "Ok":
        raise PipelineError(f"no route found ({data.get('code')})")
    route = data["routes"][0]
    return [(lat, lon) for lon, lat in route["geometry"]["coordinates"]], route["distance"]


def resample(path, step):
    """Points every `step` meters along the polyline, each with a heading."""
    if len(path) < 2:
        return []
    out = [(path[0], bearing(path[0], path[1]))]
    carry = 0.0
    for a, b in zip(path, path[1:]):
        seg = haversine(a, b)
        if seg == 0:
            continue
        hd = bearing(a, b)
        d = step - carry
        while d <= seg:
            t = d / seg
            out.append(((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t), hd))
            d += step
        carry = seg - (d - step)
    return out


def nearby_images(token, pt, radius):
    dlat = radius / 111320.0
    dlon = radius / (111320.0 * max(math.cos(math.radians(pt[0])), 0.01))
    params = {
        "access_token": token,
        "fields": (
            "id,computed_geometry,computed_compass_angle,thumb_1024_url,thumb_2048_url,"
            "is_pano,sequence,captured_at,camera_parameters"
        ),
        "bbox": f"{pt[1]-dlon},{pt[0]-dlat},{pt[1]+dlon},{pt[0]+dlat}",
        "limit": 100,
    }
    for attempt in range(4):
        try:
            r = requests.get(GRAPH, params=params, timeout=30)
        except requests.RequestException:
            time.sleep(2 ** attempt)
            continue
        if r.status_code == 200:
            return r.json().get("data", [])
        if r.status_code in (400, 401, 403):
            raise PipelineError(f"Mapillary rejected the request ({r.status_code}); check the token")
        time.sleep(2 ** attempt)
    return []


def smooth_headings(pts, step, window_m=25.0):
    """Road heading averaged over +-window_m so it does not jerk at polyline vertices."""
    k, n = max(1, round(window_m / step)), len(pts)
    return [(p, bearing(pts[max(0, i - k)][0], pts[min(n - 1, i + k)][0])) for i, (p, _) in enumerate(pts)]


def candidates_for(images, pt, heading, max_angle, allow_pano=False, align=True, k=6):
    """Candidate images near one sample point, cheapest first."""
    out = []
    for im in images:
        geom, ang, pano = im.get("computed_geometry"), im.get("computed_compass_angle"), bool(im.get("is_pano"))
        if not geom or (pano and not allow_pano):
            continue
        url = im.get("thumb_2048_url") if pano else (im.get("thumb_2048_url") or im.get("thumb_1024_url"))
        if not url or (not pano and ang is None):
            continue
        diff = 0.0 if pano else angle_diff(ang, heading)
        if diff > max_angle:
            continue
        lon, lat = geom["coordinates"]
        d = haversine(pt, (lat, lon))
        out.append({
            "id": im["id"], "seq": im.get("sequence"), "t": im.get("captured_at") or 0,
            "ang": None if pano else ang, "pano": pano, "cam": im.get("camera_parameters"),
            "url": url, "hd": heading, "u": d + diff * (0.2 if align else 0.5),
        })
    out.sort(key=lambda c: c["u"])
    return out[:k]


def trans_cost(a, b):
    """Cost of going from one chosen image to the next: staying in a sequence is cheap, while
    hopping to another sequence / date / direction (where the road shifts in the frame) is not."""
    if a["id"] == b["id"]:
        return 4.0
    c = 0.0
    if a["seq"] and a["seq"] == b["seq"]:
        if b["t"] < a["t"]:
            c += 15
    else:
        c += 25 + min(15.0, math.log10(1 + abs(a["t"] - b["t"]) / 864e5) * 5)
        if a["ang"] is not None and b["ang"] is not None:
            c += 0.3 * angle_diff(a["ang"], b["ang"])
    if a["pano"] != b["pano"]:
        c += 20
    return c


def choose_path(cands):
    """Viterbi over all sample points: one best chain of images (None where nothing is available)."""
    idx = [i for i, c in enumerate(cands) if c]
    picks = [None] * len(cands)
    if not idx:
        return picks
    layers, prev = [], None
    for i in idx:
        cur = [{"c": c, "cost": c["u"], "from": -1} for c in cands[i]]
        if prev:
            for n in cur:
                costs = [q["cost"] + trans_cost(q["c"], n["c"]) for q in prev]
                j = min(range(len(prev)), key=costs.__getitem__)
                n["cost"] += costs[j]
                n["from"] = j
        layers.append(cur)
        prev = cur
    j = min(range(len(prev)), key=lambda k: prev[k]["cost"])
    for k in range(len(layers) - 1, -1, -1):
        picks[idx[k]] = layers[k][j]["c"]
        j = layers[k][j]["from"]
    return picks


def fetch_bytes(url):
    for attempt in range(4):
        try:
            r = requests.get(url, timeout=30)
            r.raise_for_status()
            return r.content
        except requests.RequestException:
            time.sleep(2 ** attempt)
    return None


def build_video(
    token,
    start,
    end,
    output,
    workdir,
    *,
    profile="driving",
    step=10.0,
    radius=25.0,
    max_angle=60.0,
    fps=12,
    allow_pano=False,
    max_frames=0,
    delay=0.1,
    smooth=False,
    align=True,
    progress=None,
    cancelled=None,
):
    """Run the whole pipeline. `progress(stage, done, total, info)` is optional."""

    def report(stage, done=0, total=0, info=""):
        if progress:
            progress(stage, done, total, info)

    def check():
        if cancelled and cancelled():
            raise Cancelled()

    if not shutil.which("ffmpeg"):
        raise PipelineError("ffmpeg not found on the server")

    report("route")
    path, dist = get_route(start, end, profile)
    pts = smooth_headings(resample(path, step), step)
    if max_frames:
        pts = pts[:max_frames]
    if len(pts) < 2:
        raise PipelineError("route too short for the chosen frame spacing")

    work = Path(workdir)
    work.mkdir(parents=True, exist_ok=True)
    for old in work.glob("*.jpg"):
        old.unlink()

    # 1. candidates near every sample point, then one consistent chain of images
    cands = []
    for i, (pt, hd) in enumerate(pts):
        check()
        cands.append(candidates_for(nearby_images(token, pt, radius), pt, hd, max_angle, allow_pano, align))
        time.sleep(delay)
        report("search", i + 1, len(pts))
    picks = choose_path(cands)
    chosen, last_id, gaps = [], None, 0
    for c in picks:
        if c is None:
            gaps += 1
        elif c["id"] != last_id:
            chosen.append(c)
            last_id = c["id"]
    if len(chosen) < 2:
        raise PipelineError(
            "Too few images along this route. Try a larger search radius / angle, or a better-covered road."
        )
    sequences = len({c["seq"] or c["id"] for c in chosen})

    # 2. download each image and align it to the route direction
    n = 0
    for i, c in enumerate(chosen):
        check()
        data = fetch_bytes(c["url"])
        if data is None:
            gaps += 1
        else:
            n += 1
            aligner.align_frame(data, c, align).save(work / f"{n:05d}.jpg", quality=92)
        report("frames", i + 1, len(chosen), f"{n} frames, {gaps} gaps")

    if n < 2:
        raise PipelineError("Image download failed; check the network connection.")

    check()
    report("encode", 0, 0, f"{n} frames")
    vf = f"minterpolate=fps={fps*2}:mi_mode=blend" if smooth else "null"
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error", "-framerate", str(fps),
        "-i", str(work / "%05d.jpg"), "-vf", vf,
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output),
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise PipelineError(f"ffmpeg failed: {res.stderr[-300:]}")
    shutil.rmtree(work, ignore_errors=True)
    return {"frames": n, "gaps": gaps, "distance_m": round(dist), "points": len(pts), "sequences": sequences}
