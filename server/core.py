"""Core pipeline: route -> sample points -> Mapillary frames -> mp4."""
import io
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
    """Return (polyline [(lat, lon)], distance_m, maneuvers)."""
    if profile not in ("driving", "walking", "cycling"):
        raise PipelineError(f"unknown profile: {profile}")
    url = f"{OSRM.format(ROUTERS[profile])}/{start[1]},{start[0]};{end[1]},{end[0]}"
    try:
        r = requests.get(
            url,
            params={"overview": "full", "geometries": "geojson", "steps": "true"},
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
    path = [(lat, lon) for lon, lat in route["geometry"]["coordinates"]]
    return path, route["distance"], maneuvers_of(route)


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
            "id": im["id"], "lat": lat, "lon": lon, "seq": im.get("sequence"), "t": im.get("captured_at") or 0,
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


PLAIN_TYPES = {"depart", "arrive", "new name", "continue", "notification"}
APPROACH_M, AFTER_M = 60.0, 25.0   # how far before / after a decision point the video slows down


def maneuvers_of(route):
    """Decision points (turns, forks, ramps, roundabouts) from the OSRM step list; sev 0..1 = how much to slow."""
    out = []
    for leg in route.get("legs", []):
        for st in leg.get("steps", []):
            m = st.get("maneuver") or {}
            typ, mod, loc = m.get("type", ""), m.get("modifier", ""), m.get("location")
            if not loc or typ in PLAIN_TYPES or (typ == "turn" and mod in ("", "straight")):
                continue
            slight = "slight" in mod or any(w in typ for w in ("merge", "ramp", "exit"))
            out.append({"pt": (loc[1], loc[0]), "sev": 0.6 if slight else 1.0, "type": typ, "mod": mod,
                        "name": st.get("name") or "", "exit": m.get("exit") or 0})
    return out


def locate_maneuvers(pts, maneuvers, step):
    """Cumulative distance along the sampled route, and (maneuver, sample index) for every decision point on it."""
    s = [0.0]
    for i in range(1, len(pts)):
        s.append(s[-1] + haversine(pts[i - 1][0], pts[i][0]))
    at = []
    for m in maneuvers:
        dists = [haversine(p[0], m["pt"]) for p in pts]
        bi = min(range(len(pts)), key=dists.__getitem__)
        if dists[bi] <= max(40.0, step * 2):
            at.append((m, bi))
    return s, at


def pace_weights(pts, maneuvers, step):
    """0..1 per sample point: how close it is to a decision point or a sharp bend."""
    n = len(pts)
    s, at = locate_maneuvers(pts, maneuvers, step)
    w = [0.0] * n
    for m, bi in at:
        for i in range(n):
            d = s[i] - s[bi]
            z, a = (APPROACH_M if d < 0 else AFTER_M), abs(d)
            if a < z:
                w[i] = max(w[i], m["sev"] * 0.5 * (1 + math.cos(math.pi * a / z)))
    k = max(1, round(20 / step))   # bends the router does not call a manoeuvre
    for i in range(k, n - k):
        turn = angle_diff(bearing(pts[i - k][0], pts[i][0]), bearing(pts[i][0], pts[i + k][0]))
        if turn > 25:
            w[i] = max(w[i], min(1.0, turn / 80))
    return w


CUE_AHEAD_M, CUE_AFTER_M, CUE_NOW_M = 80.0, 15.0, 8.0


def cues_for(pts, maneuvers, step):
    """One cue (or None) per sample point: the nearest decision point within 80 m ahead / 15 m behind.
    dist = metres to go, rounded to 10 (0 = at the junction now)."""
    s, at = locate_maneuvers(pts, maneuvers, step)
    out = []
    for i in range(len(pts)):
        best = None
        for m, bi in at:
            d = s[bi] - s[i]
            if -CUE_AFTER_M <= d <= CUE_AHEAD_M and (best is None or abs(d) < abs(best[1])):
                best = (m, d)
        if best is None:
            out.append(None)
            continue
        m, d = best
        out.append({"type": m["type"], "mod": m["mod"], "name": m["name"], "exit": m["exit"],
                    "dist": max(10, round(d / 10) * 10) if d > CUE_NOW_M else 0})
    return out


GUIDE_FROM_M, GUIDE_TO_M, GUIDE_LEN_M = 10, 60, 45.0


def pace_durations(pts, maneuvers, step, slow):
    """Screen time per sample point in units of 1/fps: 1 on open road, up to `slow` at a decision point."""
    return [1 + (slow - 1) * w for w in pace_weights(pts, maneuvers, step)]


def route_ahead(fine, cam, length_m=GUIDE_LEN_M):
    """The next `length_m` of the fine route polyline [(lat, lon)] from the point nearest the camera."""
    bi = min(range(len(fine)), key=lambda i: haversine(cam, fine[i]))
    out, acc = [fine[bi]], 0.0
    for i in range(bi + 1, len(fine)):
        if acc >= length_m:
            break
        acc += haversine(fine[i - 1], fine[i])
        out.append(fine[i])
    return out


def build_timeline(picks, durs, cues=None):
    """Chosen images (consecutive duplicates merged) each with the screen time of the road stretch it covers."""
    chosen, last, lead, gaps = [], None, 0.0, 0
    for i, (c, d) in enumerate(zip(picks, durs)):
        if c is None:
            gaps += 1
            if chosen:
                chosen[-1]["dur"] += d
            else:
                lead += d
        elif c["id"] != last:
            chosen.append({**c, "dur": d + lead, "cue": cues[i] if cues else None})
            lead, last = 0.0, c["id"]
        else:
            chosen[-1]["dur"] += d
            if cues and not chosen[-1]["cue"]:
                chosen[-1]["cue"] = cues[i]
    return chosen, gaps


def fetch_bytes(url):
    for attempt in range(4):
        try:
            r = requests.get(url, timeout=30)
            r.raise_for_status()
            return r.content
        except requests.RequestException:
            time.sleep(2 ** attempt)
    return None


def frame_at(T, t, i, dissolve=0.3):
    """Which frame is on screen at time t: (index, blend factor towards the next frame). T[i] = start of frame i."""
    n = len(T) - 1
    while i < n - 1 and t >= T[i + 1]:
        i += 1
    if i + 1 >= n:
        return i, 0.0
    w = min(T[i + 1] - T[i], dissolve)
    return i, min(1.0, max(0.0, (t - (T[i + 1] - w)) / w))


def encode_video(files, durs, fps, smooth, output, check=None, report=None, out_fps=30):
    """Frames stay on screen for dur/fps seconds (longer at turns). smooth = dissolve between frames."""
    T = [0.0]
    for d in durs:
        T.append(T[-1] + d / fps)
    tail = ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output)]
    if not smooth:
        lst = Path(files[0]).parent / "frames.txt"
        lines = []
        for f, d in zip(files, durs):
            lines += [f"file '{Path(f).name}'", f"duration {d / fps:.4f}"]
        lines.append(f"file '{Path(files[-1]).name}'")   # concat quirk: last frame needs repeating
        lst.write_text("\n".join(lines) + "\n")
        cmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(lst),
               "-vf", f"fps={out_fps}", *tail]
        res = subprocess.run(cmd, capture_output=True, text=True)
        if res.returncode != 0:
            raise PipelineError(f"ffmpeg failed: {res.stderr[-300:]}")
        return T[-1]

    from PIL import Image
    proc = subprocess.Popen(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", str(out_fps),
         "-c:v", "mjpeg", "-i", "-", *tail],
        stdin=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    cache = {}

    def load(j):
        if j not in cache:
            cache[j] = Image.open(files[j]).convert("RGB")
            for old in [x for x in cache if x < j - 1]:
                del cache[old]
        return cache[j]

    try:
        total, i = math.ceil(T[-1] * out_fps), 0
        for k in range(total + 1):
            if check:
                check()
            i, a = frame_at(T, k / out_fps, i)
            im = load(i)
            if a > 0:
                im = Image.blend(im, load(i + 1), a)
            buf = io.BytesIO()
            im.save(buf, "JPEG", quality=92)
            proc.stdin.write(buf.getvalue())
            if report and k % 30 == 0:
                report("encode", k, total, "")
        proc.stdin.close()
        err = proc.stderr.read().decode(errors="replace")
        if proc.wait() != 0:
            raise PipelineError(f"ffmpeg failed: {err[-300:]}")
    except BaseException:
        proc.kill()
        raise
    return T[-1]


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
    fps=4.0,
    slow=3.0,
    guide=True,
    cues=True,
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
    path, dist, maneuvers = get_route(start, end, profile)
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
    chosen, gaps = build_timeline(picks, pace_durations(pts, maneuvers, step, slow), cues_for(pts, maneuvers, step))
    if len(chosen) < 2:
        raise PipelineError(
            "Too few images along this route. Try a larger search radius / angle, or a better-covered road."
        )
    if guide:   # frames shortly before a decision point get the route ahead drawn on them
        fine = [p for p, _ in resample(path, 2)]
        for c in chosen:
            if c.get("cue") and GUIDE_FROM_M <= c["cue"]["dist"] <= GUIDE_TO_M:
                c["guide"] = route_ahead(fine, (c["lat"], c["lon"]))
    sequences = len({c["seq"] or c["id"] for c in chosen})

    # 2. download each image and align it to the route direction
    files, durs, carry = [], [], 0.0   # a failed download hands its screen time to its neighbour
    for i, c in enumerate(chosen):
        check()
        data = fetch_bytes(c["url"])
        if data is None:
            gaps += 1
            if durs:
                durs[-1] += c["dur"]
            else:
                carry += c["dur"]
        else:
            f = work / f"{len(files) + 1:05d}.jpg"
            img, view = aligner.align_frame_view(data, c, align)
            if guide and c.get("guide"):
                aligner.draw_guide(img, view, c["lat"], c["lon"], c["guide"])
            if cues and c.get("cue"):
                aligner.draw_cue(img, c["cue"])
            img.save(f, quality=92)
            files.append(f)
            durs.append(c["dur"] + carry)
            carry = 0.0
        report("frames", i + 1, len(chosen), f"{len(files)} frames, {gaps} gaps")
    n = len(files)
    if n < 2:
        raise PipelineError("Image download failed; check the network connection.")

    check()
    report("encode", 0, 0, f"{n} frames")
    seconds = encode_video(files, durs, fps, smooth, output, check, report)
    shutil.rmtree(work, ignore_errors=True)
    return {"frames": n, "gaps": gaps, "distance_m": round(dist), "points": len(pts), "sequences": sequences, "seconds": round(seconds, 1), "turns": len(maneuvers)}
