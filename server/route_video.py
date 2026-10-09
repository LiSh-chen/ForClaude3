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
    ap.add_argument("--fps", type=float, default=4, help="images per second on open road (lower = slower)")
    ap.add_argument("--slow", type=float, default=3, help="slow-down factor at turns/forks (1 = off)")
    ap.add_argument("--allow-pano", action="store_true", help="use 360 panoramas, reprojected along the route (lower resolution)")
    ap.add_argument("--no-guide", action="store_true", help="do not mark the road to take on the frame")
    ap.add_argument("--no-junction-pano", action="store_true", help="do not use panoramas to look into the road to take at junctions")
    ap.add_argument("--any-view", action="store_true", help="also use images where the road is not visible (sky, walls, ...)")
    ap.add_argument("--no-cues", action="store_true", help="do not draw direction text at turns and forks")
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
            radius=a.radius, max_angle=a.max_angle, fps=a.fps, slow=a.slow, guide=not a.no_guide, allow_pano=a.allow_pano,
            smooth=a.smooth, align=not a.no_align, cues=not a.no_cues, road_only=not a.any_view, junction_pano=not a.no_junction_pano, max_frames=a.max_frames, progress=prog,
        )
    except core.PipelineError as e:
        sys.exit(f"\n{e}")
    print(f"\nDone: {a.output} {r}\nImagery: Mapillary contributors, CC-BY-SA 4.0")


if __name__ == "__main__":
    main()
