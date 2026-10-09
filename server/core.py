"""Core pipeline: route -> sample points -> Mapillary frames -> mp4."""
import math
import shutil
import subprocess
import time
from pathlib import Path

import requests

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
        "fields": "id,computed_geometry,computed_compass_angle,thumb_2048_url,is_pano",
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


def pick_best(images, pt, heading, max_angle, allow_pano=False):
    best, best_score = None, None
    for im in images:
        if im.get("is_pano") and not allow_pano:
            continue
        geom, ang = im.get("computed_geometry"), im.get("computed_compass_angle")
        if not geom or ang is None or not im.get("thumb_2048_url"):
            continue
        lon, lat = geom["coordinates"]
        diff = angle_diff(ang, heading)
        if diff > max_angle:
            continue
        score = haversine(pt, (lat, lon)) + diff * 0.3
        if best_score is None or score < best_score:
            best, best_score = im, score
    return best


def download(url, dest):
    for attempt in range(4):
        try:
            r = requests.get(url, timeout=30)
            r.raise_for_status()
            dest.write_bytes(r.content)
            return True
        except requests.RequestException:
            time.sleep(2 ** attempt)
    return False


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
    pts = resample(path, step)
    if max_frames:
        pts = pts[:max_frames]
    if len(pts) < 2:
        raise PipelineError("route too short for the chosen frame spacing")

    work = Path(workdir)
    work.mkdir(parents=True, exist_ok=True)
    for old in work.glob("*.jpg"):
        old.unlink()

    n, gaps, last_id = 0, 0, None
    for i, (pt, hd) in enumerate(pts):
        check()
        im = pick_best(nearby_images(token, pt, radius), pt, hd, max_angle, allow_pano)
        time.sleep(delay)
        if im is None:
            gaps += 1
        elif im["id"] != last_id:
            n += 1
            if download(im["thumb_2048_url"], work / f"{n:05d}.jpg"):
                last_id = im["id"]
            else:
                n -= 1
                gaps += 1
        report("frames", i + 1, len(pts), f"{n} frames, {gaps} gaps")

    if n < 2:
        raise PipelineError(
            "Too few images along this route. Try a larger search radius / angle, or a better-covered road."
        )

    check()
    report("encode", 0, 0, f"{n} frames")
    vf = "scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2"
    if smooth:
        vf += f",minterpolate=fps={fps*2}:mi_mode=blend"
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error", "-framerate", str(fps),
        "-i", str(work / "%05d.jpg"), "-vf", vf,
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output),
    ]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise PipelineError(f"ffmpeg failed: {res.stderr[-300:]}")
    shutil.rmtree(work, ignore_errors=True)
    return {"frames": n, "gaps": gaps, "distance_m": round(dist), "points": len(pts)}
