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
