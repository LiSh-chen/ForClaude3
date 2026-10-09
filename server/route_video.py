#!/usr/bin/env python3
"""CLI: python route_video.py --start LAT,LON --end LAT,LON -o out.mp4  (needs MAPILLARY_TOKEN)."""
import argparse
import os
import sys

import core


def pt(s):
    lat, lon = (float(x) for x in s.split(","))
    return lat, lon


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--start", required=True, type=pt)
    ap.add_argument("--end", required=True, type=pt)
    ap.add_argument("-o", "--output", default="route.mp4")
    ap.add_argument("--profile", default="driving", choices=["driving", "walking", "cycling"])
    ap.add_argument("--step", type=float, default=10)
    ap.add_argument("--radius", type=float, default=25)
    ap.add_argument("--max-angle", type=float, default=60)
    ap.add_argument("--fps", type=int, default=12)
    ap.add_argument("--allow-pano", action="store_true", help="use 360 panoramas, reprojected along the route (lower resolution)")
    ap.add_argument("--no-align", action="store_true", help="do not shift frames to centre the road direction")
    ap.add_argument("--smooth", action="store_true")
    ap.add_argument("--max-frames", type=int, default=0)
    ap.add_argument("--workdir", default="frames")
    a = ap.parse_args()
    token = os.environ.get("MAPILLARY_TOKEN")
    if not token:
        sys.exit("Set MAPILLARY_TOKEN first.")

    def prog(stage, done, total, info):
        print(f"\r{stage} {done}/{total} {info}", end="", flush=True)

    try:
        r = core.build_video(
            token, a.start, a.end, a.output, a.workdir, profile=a.profile, step=a.step,
            radius=a.radius, max_angle=a.max_angle, fps=a.fps, allow_pano=a.allow_pano,
            smooth=a.smooth, align=not a.no_align, max_frames=a.max_frames, progress=prog,
        )
    except core.PipelineError as e:
        sys.exit(f"\n{e}")
    print(f"\nDone: {a.output} {r}\nImagery: Mapillary contributors, CC-BY-SA 4.0")


if __name__ == "__main__":
    main()
