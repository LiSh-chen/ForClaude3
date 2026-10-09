"""Web app: pick start/end on a map, generate a street-level route video, download it.

  export MAPILLARY_TOKEN='MLY|...'   # optional; users can also paste one in the UI
  python app.py                      # http://127.0.0.1:8000
"""
import os
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory

import core

BASE = Path(__file__).parent
DATA = Path(os.environ.get("SV_DATA_DIR", BASE / "data"))
DATA.mkdir(parents=True, exist_ok=True)
MAX_JOBS_KEPT = 20
MAX_FRAMES_LIMIT = int(os.environ.get("SV_MAX_FRAMES", "1500"))

app = Flask(__name__, static_folder=str(BASE / "static"), static_url_path="/static")
pool = ThreadPoolExecutor(max_workers=int(os.environ.get("SV_WORKERS", "2")))
jobs = {}
lock = threading.Lock()


def _coord(v, name):
    try:
        lat, lon = float(v["lat"]), float(v["lon"])
    except (KeyError, TypeError, ValueError):
        raise ValueError(f"{name} must be {{lat, lon}}")
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise ValueError(f"{name} out of range")
    return lat, lon


def _num(body, key, default, lo, hi, cast=float):
    try:
        v = cast(body.get(key, default))
    except (TypeError, ValueError):
        raise ValueError(f"{key} must be a number")
    if not lo <= v <= hi:
        raise ValueError(f"{key} must be between {lo} and {hi}")
    return v


def _run(job_id, token, start, end, opts):
    job = jobs[job_id]
    out = DATA / f"{job_id}.mp4"

    def progress(stage, done, total, info):
        job.update(stage=stage, done=done, total=total, info=info)

    try:
        job["status"] = "running"
        result = core.build_video(
            token, start, end, out, DATA / f"{job_id}_frames",
            progress=progress, cancelled=lambda: job["cancel"], **opts,
        )
        job.update(status="done", result=result, stage="done")
    except core.Cancelled:
        job.update(status="cancelled")
    except core.PipelineError as e:
        job.update(status="error", error=str(e))
    except Exception as e:  # keep the worker alive on unexpected failures
        job.update(status="error", error=f"unexpected error: {e}")


def _public(job):
    return {k: v for k, v in job.items() if k not in ("cancel",)}


def _prune():
    with lock:
        old = sorted(jobs.values(), key=lambda j: j["created"])
        for j in old[:-MAX_JOBS_KEPT]:
            if j["status"] in ("done", "error", "cancelled"):
                (DATA / f"{j['id']}.mp4").unlink(missing_ok=True)
                jobs.pop(j["id"], None)


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/api/config")
def config():
    return jsonify(server_token=bool(os.environ.get("MAPILLARY_TOKEN")), max_frames=MAX_FRAMES_LIMIT)


@app.get("/api/geocode")
def geocode():
    q = request.args.get("q", "").strip()
    if not q:
        return jsonify(results=[])
    try:
        return jsonify(results=core.geocode(q))
    except Exception as e:
        return jsonify(error=f"geocoding failed: {e}"), 502


@app.post("/api/route")
def route_preview():
    b = request.get_json(silent=True) or {}
    try:
        start, end = _coord(b.get("start"), "start"), _coord(b.get("end"), "end")
        step = _num(b, "step", 10, 3, 100)
        path, dist = core.get_route(start, end, b.get("profile", "driving"))
    except ValueError as e:
        return jsonify(error=str(e)), 400
    except core.PipelineError as e:
        return jsonify(error=str(e)), 502
    return jsonify(path=path, distance_m=round(dist), est_frames=int(dist // step) + 1)


@app.post("/api/jobs")
def create_job():
    b = request.get_json(silent=True) or {}
    token = os.environ.get("MAPILLARY_TOKEN") or (b.get("token") or "").strip()
    if not token:
        return jsonify(error="Mapillary token required"), 400
    try:
        start, end = _coord(b.get("start"), "start"), _coord(b.get("end"), "end")
        profile = b.get("profile", "driving")
        if profile not in ("driving", "walking", "cycling"):
            raise ValueError("invalid profile")
        opts = dict(
            profile=profile,
            step=_num(b, "step", 10, 3, 100),
            radius=_num(b, "radius", 25, 5, 100),
            max_angle=_num(b, "max_angle", 60, 10, 180),
            fps=_num(b, "fps", 12, 1, 30, int),
            max_frames=_num(b, "max_frames", 0, 0, MAX_FRAMES_LIMIT, int),
            allow_pano=bool(b.get("allow_pano")),
            smooth=bool(b.get("smooth")),
            align=bool(b.get("align", True)),
        )
    except ValueError as e:
        return jsonify(error=str(e)), 400
    job_id = uuid.uuid4().hex[:12]
    jobs[job_id] = dict(
        id=job_id, status="queued", stage="queued", done=0, total=0, info="",
        created=time.time(), cancel=False, start=start, end=end, opts=opts,
    )
    pool.submit(_run, job_id, token, start, end, opts)
    _prune()
    return jsonify(id=job_id), 202


@app.get("/api/jobs")
def list_jobs():
    return jsonify(jobs=[_public(j) for j in sorted(jobs.values(), key=lambda j: -j["created"])])


@app.get("/api/jobs/<job_id>")
def get_job(job_id):
    job = jobs.get(job_id)
    return (jsonify(_public(job)), 200) if job else (jsonify(error="not found"), 404)


@app.post("/api/jobs/<job_id>/cancel")
def cancel_job(job_id):
    job = jobs.get(job_id)
    if not job:
        return jsonify(error="not found"), 404
    job["cancel"] = True
    return jsonify(ok=True)


@app.get("/api/jobs/<job_id>/video")
def video(job_id):
    job = jobs.get(job_id)
    if not job or job["status"] != "done":
        return jsonify(error="not ready"), 404
    return send_from_directory(
        DATA, f"{job_id}.mp4", mimetype="video/mp4",
        as_attachment=request.args.get("download") == "1", download_name="route.mp4",
        conditional=True,
    )


if __name__ == "__main__":
    app.run(host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", "8000")), threaded=True)
