import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

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


def img(i, lat, lon, ang, pano=False):
    return {"id": i, "computed_geometry": {"coordinates": [lon, lat]},
            "computed_compass_angle": ang, "thumb_2048_url": "u", "is_pano": pano}


def test_pick_best_prefers_close_and_aligned():
    pt = (25.0, 121.0)
    imgs = [img("far", 25.0002, 121.0, 0), img("near", 25.00005, 121.0, 5),
            img("wrong", 25.0, 121.0, 180), img("pano", 25.0, 121.0, 0, pano=True)]
    assert core.pick_best(imgs, pt, 0, 60)["id"] == "near"
    assert core.pick_best([imgs[2]], pt, 0, 60) is None
    assert core.pick_best([imgs[3]], pt, 0, 60) is None
    assert core.pick_best([imgs[3]], pt, 0, 60, allow_pano=True)["id"] == "pano"


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
