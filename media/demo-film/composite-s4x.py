#!/usr/bin/env python3
"""Put a real-looking Thesis lock screen on the blank white phone in the copy-trading shot (s4x).

Seedance garbles long on-screen text, so s4x was generated with a plain white phone screen
(film/public/shots/s4x-raw.mp4, take 4). This script:
  1. tracks the screen's four corners in every frame (largest bright region → convex hull → 4 corners),
     smoothed over 5 frames, and saves them to film/src/s4x-screen.json;
  2. warps each frame of the PhoneUI render (film/src/Screens.tsx, PNG sequence) onto that quad,
     using the white screen itself as the matte so his thumbs stay in front;
  3. pushes in slowly (1.0 → 1.45) while the notifications land, upscales to 1080p, keeps the audio,
     and writes film/public/shots/s4x-composite.mp4 (copy it to s4x.mp4 to use it in the story).

Usage (or just run ./composite-s4x.sh, which renders PhoneUI first):
  python3 composite-s4x.py <phone-ui-png-dir>
Needs: numpy, opencv-python-headless, ffmpeg.
"""
import glob
import json
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "film/public/shots/s4x-raw.mp4"
QUADS = ROOT / "film/src/s4x-screen.json"
OUT = ROOT / "film/public/shots/s4x-composite.mp4"
W0, H0, W, H, FPS = 854, 480, 1920, 1080, 24
UI_FRAMES = 66            # the over-the-shoulder part of the shot, before it cuts to his face
PUSH = 0.45               # zoom added over those frames
PUSH_CENTER = (512, 260)  # roughly the phone, in source pixels


def frames_of(path):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, H0, W0, 3)


def track(frames):
    """Corners (TL, TR, BR, BL, in source pixels) of the white screen per frame, or None once it's gone."""
    quads = []
    for fr in frames:
        m = (fr.min(axis=2) > 200).astype(np.uint8)
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        n, lab, stats, _ = cv2.connectedComponentsWithStats(m)
        if n < 2:
            quads.append(None); continue
        k = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
        if stats[k, cv2.CC_STAT_AREA] < 4000:  # no big white screen: the shot has cut away
            quads.append(None); continue
        cnts, _ = cv2.findContours((lab == k).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        hull = cv2.convexHull(cnts[0])  # the hull fills in where his thumbs cover the edge
        peri = cv2.arcLength(hull, True)
        q = None
        for e in np.linspace(0.01, 0.1, 40):
            ap = cv2.approxPolyDP(hull, e * peri, True)
            if len(ap) == 4:
                q = ap.reshape(4, 2).astype(float); break
        if q is None:
            quads.append(None); continue
        q = q[np.argsort(q[:, 1])]
        top, bot = q[:2][np.argsort(q[:2, 0])], q[2:][np.argsort(q[2:, 0])]
        quads.append([top[0].tolist(), top[1].tolist(), bot[1].tolist(), bot[0].tolist()])
    idx = [i for i, q in enumerate(quads) if q]
    arr = np.array([quads[i] for i in idx])
    sm = np.array([arr[max(0, j - 2): j + 3].mean(0) for j in range(len(arr))])
    for j, i in enumerate(idx):
        quads[i] = sm[j].round(2).tolist()
    return quads


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    ui = [cv2.cvtColor(cv2.imread(p), cv2.COLOR_BGR2RGB) for p in sorted(glob.glob(f"{sys.argv[1]}/*.png"))]
    if not ui:
        sys.exit(f"no PNGs in {sys.argv[1]}")
    uh, uw = ui[0].shape[:2]
    frames = frames_of(SRC)
    quads = track(frames)
    QUADS.write_text(json.dumps({"w": W0, "h": H0, "fps": FPS, "quads": quads}))
    seen = [i for i, q in enumerate(quads) if q]
    print(f"tracked the screen in frames {seen[0]}–{seen[-1]} → {QUADS.relative_to(ROOT)}")

    sx = W / W0
    enc = subprocess.Popen(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-",
                            "-i", str(SRC), "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-crf", "16", "-preset", "medium",
                            "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-shortest", str(OUT)], stdin=subprocess.PIPE)
    src_rect = np.float32([[0, 0], [uw, 0], [uw, uh], [0, uh]])
    for i, fr in enumerate(frames):
        big = cv2.resize(fr, (W, H), interpolation=cv2.INTER_LANCZOS4).astype(np.float32)
        q = quads[i] if i < len(quads) else None
        if q and i < len(ui):
            dst = np.array(q, np.float32) * sx
            c = dst.mean(0)
            dst = c + (dst - c) * 1.03  # a touch past the screen edge so no white rim shows; the matte keeps it on the screen
            Hm = cv2.getPerspectiveTransform(src_rect, dst)
            warped = cv2.warpPerspective(ui[i], Hm, (W, H), flags=cv2.INTER_LINEAR).astype(np.float32)
            inside = cv2.warpPerspective(np.full((uh, uw), 255, np.uint8), Hm, (W, H)).astype(np.float32) / 255
            matte = np.clip((big.min(axis=2) - 120) / 50, 0, 1)  # the white screen; thumbs and hand are darker → stay in front
            matte = cv2.GaussianBlur(matte, (0, 0), 1.2)
            a = (matte * inside)[..., None]
            big = big * (1 - a) + warped * a
        if i < UI_FRAMES:
            z = 1 + PUSH * (i / (UI_FRAMES - 1)) ** 1.2
            cx, cy = PUSH_CENTER[0] * sx, PUSH_CENTER[1] * sx
            M = np.float32([[z, 0, (1 - z) * cx], [0, z, (1 - z) * cy]])
            big = cv2.warpAffine(big, M, (W, H), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REFLECT)
        enc.stdin.write(big.clip(0, 255).astype(np.uint8).tobytes())
    enc.stdin.close()
    enc.wait()
    print(f"wrote {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
