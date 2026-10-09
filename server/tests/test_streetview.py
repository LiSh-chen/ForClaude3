import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

import align
import core
import app as webapp


def test_resample_spacing_and_count():
    path = [(25.0, 121.0), (25.001, 121.0), (25.001, 121.001)]
    pts = core.resample(path, 10)
    total = sum(core.haversine(a, b) for a, b in zip(path, path[1:]))
    assert abs(len(pts) - (total // 10 + 1)) <= 1
    assert pts[0][1] == pytest.approx(0, abs=1)        # heading north first
    assert pts[-1][1] == pytest.approx(90, abs=1)      # then east


def test_angle_diff_wraps():
    assert core.angle_diff(350, 10) == 20


def img(i, lat, lon, ang, pano=False, seq=None):
    return {"id": i, "computed_geometry": {"coordinates": [lon, lat]}, "computed_compass_angle": ang,
            "thumb_2048_url": "u", "is_pano": pano, "sequence": seq, "captured_at": 10**12}


def test_candidates_filter_and_order():
    pt = (25.0, 121.0)
    imgs = [img("far", 25.0002, 121.0, 0), img("near", 25.00005, 121.0, 5),
            img("wrong", 25.0, 121.0, 180), img("pano", 25.0, 121.0, 0, pano=True)]
    ids = [c["id"] for c in core.candidates_for(imgs, pt, 0, 60)]
    assert ids == ["near", "far"]                       # wrong direction and pano dropped
    ids = [c["id"] for c in core.candidates_for(imgs, pt, 0, 60, allow_pano=True)]
    assert "pano" in ids and "wrong" not in ids


def test_choose_path_prefers_one_sequence():
    def cand(i, seq, u):
        return {"id": f"{seq}{i}", "seq": seq, "t": 10**12, "ang": 0, "pano": False, "u": u}
    cands = [[cand(i, "S1", 8), cand(i, f"X{i}", 3)] for i in range(5)]
    assert {c["seq"] for c in core.choose_path(cands)} == {"S1"}      # nearest-per-point would hop every time
    assert core.choose_path([[], []]) == [None, None]
    assert core.choose_path([[cand(0, "S1", 1)], [], [cand(2, "S1", 1)]])[1] is None


def test_smooth_headings_round_corner():
    pts = core.resample([(25.0, 121.0), (25.001, 121.0), (25.001, 121.001)], 5)
    sm = core.smooth_headings(pts, 5)
    assert abs(sm[0][1] - 0) < 1 and abs(sm[-1][1] - 90) < 1
    corner = min(range(len(pts)), key=lambda i: abs(pts[i][0][0] - 25.001))
    assert 20 < sm[corner][1] < 70                      # raw heading flips 0 -> 90, smoothed one turns gradually


def _column(im):
    """Centre of the red stripe on the middle row."""
    px, row = im.load(), im.height // 2
    score = [px[x, row][0] - px[x, row][1] for x in range(im.width)]
    top = max(score)
    xs = [x for x, v in enumerate(score) if v >= 0.9 * top]
    return sum(xs) / len(xs)


def _jpeg(img):
    import io
    b = io.BytesIO()
    img.save(b, "PNG")
    return b.getvalue()


def test_align_shifts_road_to_centre():
    from PIL import Image
    src = Image.new("RGB", (1600, 1200), (136, 136, 136))
    for x in range(796, 804):
        for y in range(1200):
            src.putpixel((x, y), (255, 0, 0))
    meta = {"ang": 0.0, "hd": 3.0, "pano": False, "cam": [0.8, 0, 0]}
    x_aligned = _column(align.align_frame(_jpeg(src), meta, True))
    x_plain = _column(align.align_frame(_jpeg(src), meta, False))
    assert x_plain == pytest.approx(640, abs=3)
    assert 560 < x_aligned < 585                        # camera centre moves left of the road direction


def test_pano_reprojection_looks_along_route():
    import numpy as np
    from PIL import Image
    arr = np.full((512, 1024, 3), 136, dtype=np.uint8)
    arr[:, int(0.75 * 1024) - 2:int(0.75 * 1024) + 2] = (255, 0, 0)   # stripe due east
    meta = {"ang": 0.0, "hd": 90.0, "pano": True, "cam": None}
    assert _column(align.align_frame(_jpeg(Image.fromarray(arr)), meta)) == pytest.approx(640, abs=4)
    meta["hd"] = 100.0
    assert _column(align.align_frame(_jpeg(Image.fromarray(arr)), meta)) < 560


def test_maneuvers_skip_plain_steps():
    route = {"legs": [{"steps": [
        {"maneuver": {"type": "depart", "location": [121.0, 25.0]}},
        {"maneuver": {"type": "turn", "modifier": "right", "location": [121.0, 25.001]}},
        {"maneuver": {"type": "turn", "modifier": "straight", "location": [121.0, 25.002]}},
        {"maneuver": {"type": "fork", "modifier": "left", "location": [121.0, 25.003]}},
        {"maneuver": {"type": "off ramp", "modifier": "slight right", "location": [121.0, 25.004]}},
        {"maneuver": {"type": "arrive", "location": [121.0, 25.005]}}]}]}
    got = core.maneuvers_of(route)
    assert [m["type"] for m in got] == ["turn", "fork", "off ramp"]
    assert [m["sev"] for m in got] == [1.0, 1.0, 0.6]


def test_pace_slows_near_turn_only():
    pts = core.resample([(25.0, 121.0), (25.0045, 121.0), (25.009, 121.0)], 10)
    mid = len(pts) // 2
    d = core.pace_durations(pts, [{"pt": pts[mid][0], "sev": 1.0}], 10, 3)
    assert d[mid] == pytest.approx(3.0, abs=0.01)                      # full slow-down at the decision point
    assert d[mid - 3] == pytest.approx(2.0, abs=0.01) and d[mid - 5] > 1                            # eases in over ~60 m before it
    assert d[mid - 6] == 1.0 and d[mid + 3] == 1.0 and d[0] == 1.0       # open road keeps normal pace
    assert core.pace_durations(pts, [], 10, 3) == [1.0] * len(pts)      # no turns, no slow-down
    assert core.pace_durations(pts, [{"pt": pts[mid][0], "sev": 1.0}], 10, 1) == [1.0] * len(pts)


def test_pace_slows_on_sharp_bend_without_maneuver():
    pts = core.resample([(25.0, 121.0), (25.001, 121.0), (25.001, 121.001)], 5)
    assert max(core.pace_durations(pts, [], 5, 3)) > 2


def test_timeline_merges_duplicates_and_gaps():
    c = lambda i: {"id": i, "seq": None, "t": 0, "ang": 0, "pano": False, "u": 0}
    chosen, gaps = core.build_timeline([None, c("a"), c("a"), None, c("b")], [1, 1, 1, 2, 1])
    assert gaps == 2
    assert [(x["id"], x["dur"]) for x in chosen] == [("a", 5), ("b", 1)]   # lead gap + duplicate + trailing gap folded in
    assert sum(x["dur"] for x in chosen) == 6                            # no screen time is lost


def test_frame_at_holds_then_dissolves():
    T = [0, 1.0, 1.2, 1.4]                                              # frame 0 is a long (slow) one
    assert core.frame_at(T, 0.2, 0) == (0, 0.0)                         # still holding the first frame
    i, a = core.frame_at(T, 0.9, 0)
    assert i == 0 and 0 < a < 1                                         # dissolving into the next
    assert core.frame_at(T, 1.1, 0)[0] == 1


@pytest.mark.parametrize("smooth", [False, True])
def test_encode_video_length_follows_durations(tmp_path, smooth):
    import shutil
    import subprocess
    from PIL import Image
    if not shutil.which("ffmpeg"):
        pytest.skip("ffmpeg missing")
    files = []
    for k in range(4):
        f = tmp_path / f"{k+1:05d}.jpg"
        Image.new("RGB", (320, 180), (40 * k, 90, 160)).save(f)
        files.append(f)
    out = tmp_path / "o.mp4"
    secs = core.encode_video(files, [1, 1, 3, 1], 2.0, smooth, out)     # 6 units at 2 images/s
    assert secs == pytest.approx(3.0)
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(out)],
                       capture_output=True, text=True)
    assert float(r.stdout) == pytest.approx(3.0, abs=0.25)


def _fine_route():
    return [p for p, _ in core.resample(_ground([(0, 0), (0, 200)]), 2)]


def _junction():
    return [{"type": "turn", "mod": "left", "name": "民權路", "exit": 0, "sev": 1.0, "pt": _ground([(0, 100)])[0]}]


def _frames(zs):
    return [{"lat": _ground([(0, z)])[0][0], "lon": _ground([(0, z)])[0][1]} for z in zs]


def test_cues_are_measured_from_the_camera_and_clear_after_the_junction():
    frames = _frames([10, 30, 50, 95, 100, 112, 120])
    core.attach_cues(frames, _fine_route(), _junction())
    got = [f["cue"]["dist"] if f["cue"] else None for f in frames]
    assert got == [None, 70, 50, 0, 0, 0, None]                          # countdown, "now" around the junction, then cleared
    assert frames[1]["cue"]["name"] == "民權路" and frames[1]["cue"]["pt"] == _junction()[0]["pt"]


def test_cue_distance_follows_where_the_image_was_taken_not_the_sample_point():
    # picked for a sample 50 m before the junction, but the photo itself was taken 20 m further on
    frame = _frames([70])
    core.attach_cues(frame, _fine_route(), _junction())
    assert frame[0]["cue"]["dist"] == 30


def test_cue_text_chinese_and_english():
    cue = {"type": "turn", "mod": "right", "name": "中山北路二段", "exit": 0, "dist": 50}
    assert align.cue_text(cue, True) == ("50 公尺後 右轉", "進入 中山北路二段")
    assert align.cue_text({**cue, "dist": 0}, True)[0] == "右轉"
    assert align.cue_text(cue, False) == ("In 50 m: Turn right", "")      # non-ASCII names dropped without a CJK font
    assert align.cue_text({**cue, "name": "Main St"}, False)[1] == "onto Main St"
    rb = {"type": "roundabout", "mod": "right", "name": "", "exit": 2, "dist": 30}
    assert align.cue_text(rb, True)[0] == "30 公尺後 進入圓環，第 2 個出口"
    assert align.cue_text({"type": "fork", "mod": "slight left", "name": "", "dist": 0}, True)[0] == "叉路靠左"
    assert align.cue_text({"type": "off ramp", "mod": "slight right", "name": "", "dist": 0}, False)[0] == "Take the exit"


@pytest.mark.parametrize("font", ["cjk", "default"])
def test_draw_cue_only_touches_the_banner(monkeypatch, font):
    from PIL import Image, ImageChops
    if font == "default":
        monkeypatch.setattr(align, "_font_path", None)
    elif not align.find_cjk_font():
        pytest.skip("no CJK font installed")
    base = Image.new("RGB", (1280, 720), (120, 160, 200))
    img = base.copy()
    align.draw_cue(img, {"type": "turn", "mod": "left", "name": "Main St", "exit": 0, "dist": 40})
    box = ImageChops.difference(base, img).getbbox()
    assert box and box[1] >= 20 and box[3] <= 160                      # drawn near the top
    assert 300 < box[0] and box[2] < 980                               # and centred


def _ground(points):
    """[(east_m, north_m)] -> [(lat, lon)] around (25, 121)."""
    return [(25.0 + z / 111320.0, 121.0 + x / (111320.0 * math.cos(math.radians(25)))) for x, z in points]


def test_route_ahead_takes_next_45m_from_nearest_point():
    fine = [p for p, _ in core.resample(_ground([(0, 0), (0, 200)]), 2)]
    ahead = core.route_ahead(fine, _ground([(1, 50)])[0])
    assert 22 <= len(ahead) <= 25
    assert core.haversine(ahead[0], _ground([(0, 50)])[0]) < 2
    assert core.haversine(ahead[0], ahead[-1]) == pytest.approx(45, abs=3)


def test_guide_shape_follows_the_branch_and_ignores_what_is_behind():
    view = {"cx": 640, "cy": 360, "f": 900, "heading": 0}
    straight = align.guide_shape(view, 25.0, 121.0, _ground([(0, z) for z in range(0, 46, 2)]))
    assert straight["C"][-1][0] == pytest.approx(640, abs=1)                       # dead ahead stays centred
    assert straight["C"][-1][1] > 360                                                # and below the horizon
    right = align.guide_shape(view, 25.0, 121.0, _ground([(0 if z < 15 else (z - 15) * 0.35, z) for z in range(0, 46, 2)]))
    assert right["C"][-1][0] > 800                                                   # bends towards the right-hand branch
    left = align.guide_shape(view, 25.0, 121.0, _ground([(0 if z < 15 else -(z - 15) * 0.35, z) for z in range(0, 46, 2)]))
    assert left["C"][-1][0] < 480
    assert align.guide_shape({**view, "heading": 180}, 25.0, 121.0, _ground([(0, z) for z in range(0, 46, 2)])) is None


def test_view_follows_the_alignment_shift():
    from PIL import Image
    meta = {"ang": 0.0, "hd": 3.0, "pano": False, "cam": [0.8, 0, 0]}
    img, view = align.align_frame_view(_jpeg(Image.new("RGB", (1600, 1200))), meta, True)
    assert img.size == (1280, 720) and view["heading"] == 0.0
    assert 560 < view["cx"] < 585                                                    # optical axis moved left of centre
    _, pano = align.align_frame_view(_jpeg(Image.new("RGB", (1024, 512))), {"ang": 0.0, "hd": 90.0, "pano": True, "cam": None})
    assert pano["heading"] == 90.0 and pano["cx"] == 640


def test_junction_state():
    view = {"cx": 640, "cy": 360, "f": 900, "heading": 0}
    st = lambda x, z: align.junction_state(view, 25.0, 121.0, _ground([(x, z)])[0])
    assert st(0, 30) == "in" and st(-6, 15) == "in"
    assert st(-15, 8) == "left" and st(15, 8) == "right"               # beside the camera: outside the picture
    assert st(0, -10) is None and st(0, 200) is None                   # behind / too far ahead


def _guide_cue(x, z):
    return {"type": "turn", "mod": "left", "name": "", "exit": 0, "dist": 20, "pt": _ground([(x, z)])[0]}


def test_draw_guide_paints_a_path_when_the_junction_is_in_the_picture():
    from PIL import Image, ImageChops
    view = {"cx": 640, "cy": 360, "f": 900, "heading": 0}
    base = Image.new("RGB", (1280, 720), (120, 120, 120))
    img = base.copy()
    ahead = _ground([(0 if z < 25 else -(z - 25) * 0.35, z) for z in range(0, 46, 2)])
    align.draw_guide(img, view, 25.0, 121.0, ahead, _guide_cue(0, 25))
    box = ImageChops.difference(base, img).getbbox()
    assert box and box[3] > 600 and box[1] > 150                       # green path starts at the bottom edge


def test_draw_guide_only_points_to_the_side_when_the_junction_is_out_of_view():
    from PIL import Image, ImageChops
    view = {"cx": 640, "cy": 360, "f": 900, "heading": 0}
    base = Image.new("RGB", (1280, 720), (120, 120, 120))
    ahead = _ground([(0 if z < 8 else -(z - 8) * 0.9, z) for z in range(0, 46, 2)])
    img = base.copy()
    align.draw_guide(img, view, 25.0, 121.0, ahead, _guide_cue(-15, 8))
    box = ImageChops.difference(base, img).getbbox()
    assert box and box[0] == 0 and box[2] < 400 and box[3] < 460       # just a small pill on the left edge
    gone = base.copy()
    align.draw_guide(gone, view, 25.0, 121.0, ahead, _guide_cue(0, -10))   # junction already behind the camera
    assert ImageChops.difference(base, gone).getbbox() is None


def _scene(layers, w=640, h=480, seed=7):
    """layers: [(y0, y1, kind, base, noise)] fractions of height; kind 'sky' = smooth blue gradient."""
    import numpy as np
    rng = np.random.default_rng(seed)
    img = np.zeros((h, w, 3), dtype=np.float32)
    for y0, y1, kind, base, noise in layers:
        a, b = int(y0 * h), int(y1 * h)
        if kind == "sky":
            ys = np.arange(a, b, dtype=np.float32)[:, None, None]
            img[a:b] = np.array([120, 170, 235], dtype=np.float32) + ys * np.array([0.05, 0.03, 0], dtype=np.float32)
        else:
            img[a:b] = np.array(base, dtype=np.float32) + rng.uniform(-noise / 2, noise / 2, (b - a, w, 3))
    return np.clip(img, 0, 255).astype(np.uint8)


def _sky_verdict(arr):
    from PIL import Image
    small = Image.fromarray(arr).resize((96, 72), Image.BOX)
    import numpy as np
    return align.looks_at_sky(align.sky_stats(np.asarray(small)))


def test_sky_check_rejects_pictures_of_the_sky_and_keeps_street_views():
    road = ("flat", (110, 110, 112), 40)
    sunlit_road = ("flat", (185, 185, 189), 4)               # smooth and bright, must not be mistaken for sky
    overcast = ("flat", (205, 205, 209), 4)
    town = ("flat", (120, 110, 100), 90)
    keep = {
        "normal": [(0, .4, "sky", 0, 0), (.4, .55, *town[:1], town[1], town[2]), (.55, 1, road[0], road[1], road[2])],
        "overcast_sunlit_road": [(0, .35, "flat", overcast[1], 4), (.35, .55, "flat", (110, 120, 100), 110), (.55, 1, "flat", sunlit_road[1], 4)],
        "open_horizon": [(0, .5, "sky", 0, 0), (.5, 1, "flat", (170, 170, 174), 4)],
    }
    reject = {
        "up_blue": [(0, .85, "sky", 0, 0), (.85, 1, "flat", (60, 90, 50), 100)],
        "up_overcast": [(0, .9, "flat", (215, 215, 219), 4), (.9, 1, "flat", (70, 70, 70), 100)],
        "pure_sky": [(0, 1, "sky", 0, 0)],
    }
    for name, layers in keep.items():
        assert not _sky_verdict(_scene(layers)), name
    for name, layers in reject.items():
        assert _sky_verdict(_scene(layers)), name


def test_undecodable_thumbnail_is_not_treated_as_sky():
    assert align.is_sky_image(b"not an image") is False


def test_build_video_replaces_sky_images(tmp_path, monkeypatch):
    import io
    import shutil
    from PIL import Image
    if not shutil.which("ffmpeg"):
        pytest.skip("ffmpeg missing")

    def jpg(arr):
        b = io.BytesIO()
        Image.fromarray(arr).save(b, "JPEG")
        return b.getvalue()
    sky = jpg(_scene([(0, 1, "sky", 0, 0)], 320, 240))
    ok = jpg(_scene([(0, .4, "sky", 0, 0), (.4, .55, "flat", (120, 110, 100), 90), (.55, 1, "flat", (110, 110, 112), 40)], 320, 240))
    main = jpg(_scene([(0, 1, "flat", (110, 110, 112), 40)], 800, 600))
    path = [(25.0, 121.0), (25.002, 121.0)]
    monkeypatch.setattr(core, "get_route", lambda *a, **k: (path, 222, []))

    def near(token, pt, radius):
        mk = lambda i, dla, thumb: {"id": f"{i}{pt[0]:.6f}", "sequence": "S", "captured_at": 10**12, "camera_parameters": [0.8, 0, 0],
                                    "computed_geometry": {"coordinates": [121.0, pt[0] + dla]}, "computed_compass_angle": 0,
                                    "is_pano": False, "thumb_256_url": thumb, "thumb_2048_url": "main"}
        return [mk("sky", 0.00001, "sky"), mk("ok", 0.00005, "ok")]     # the sky picture is the closer one
    store = {"sky": sky, "ok": ok, "main": main}
    monkeypatch.setattr(core, "nearby_images", near)
    monkeypatch.setattr(core, "fetch_bytes", lambda u: store[u])
    used = []
    real = align.align_frame_view
    monkeypatch.setattr(align, "align_frame_view", lambda data, meta, a=True: (used.append(meta["id"][:2]), real(data, meta, a))[1])
    r = core.build_video("t", (0, 0), (1, 1), tmp_path / "o.mp4", tmp_path / "f", delay=0)
    assert set(used) == {"ok"} and r["sky_skipped"] == r["frames"] > 0
    used.clear()
    r = core.build_video("t", (0, 0), (1, 1), tmp_path / "o2.mp4", tmp_path / "f2", delay=0, avoid_sky=False)
    assert set(used) == {"sk"} and r["sky_skipped"] == 0                # filter off: the closer (sky) picture wins


@pytest.fixture
def client(monkeypatch):
    monkeypatch.delenv("MAPILLARY_TOKEN", raising=False)
    webapp.app.testing = True
    return webapp.app.test_client()


def test_job_requires_token(client):
    r = client.post("/api/jobs", json={"start": {"lat": 1, "lon": 1}, "end": {"lat": 2, "lon": 2}})
    assert r.status_code == 400


def test_job_validation(client):
    bad = {"start": {"lat": 95, "lon": 1}, "end": {"lat": 2, "lon": 2}, "token": "x"}
    assert client.post("/api/jobs", json=bad).status_code == 400
    bad = {"start": {"lat": 1, "lon": 1}, "end": {"lat": 2, "lon": 2}, "token": "x", "step": 0}
    assert client.post("/api/jobs", json=bad).status_code == 400


def test_job_lifecycle_with_stubbed_pipeline(client, monkeypatch, tmp_path):
    def fake(token, start, end, output, workdir, progress=None, cancelled=None, **kw):
        progress("frames", 1, 1, "ok")
        Path(output).write_bytes(b"mp4")
        return {"frames": 2, "gaps": 0, "distance_m": 100, "points": 2}
    monkeypatch.setattr(core, "build_video", fake)
    monkeypatch.setattr(webapp, "DATA", tmp_path)
    body = {"start": {"lat": 1, "lon": 1}, "end": {"lat": 2, "lon": 2}, "token": "t"}
    jid = client.post("/api/jobs", json=body).get_json()["id"]
    import time
    for _ in range(50):
        j = client.get(f"/api/jobs/{jid}").get_json()
        if j["status"] in ("done", "error"):
            break
        time.sleep(0.05)
    assert j["status"] == "done"
    assert "token" not in str(j)
    assert client.get(f"/api/jobs/{jid}/video").data == b"mp4"
    assert client.get("/api/jobs/nope").status_code == 404
