#!/usr/bin/env python3
"""Generate the Thesis reel on Replicate: reference images (Seedream 4.5) and shots (Seedance 2.5).

  python3 gen.py refs [--force]
  python3 gen.py shots [--res 480p|720p] [--only s1,s6] [--takes N]
  python3 gen.py cost [--res 720p] [--only ...] [--takes N]

The Replicate token comes from $REPLICATE_API_TOKEN, else the macOS Keychain (service "replicate-api-token").
Existing outputs are skipped, so rerunning only fills in what's missing.
"""
import argparse
import json
import mimetypes
import os
import subprocess
import sys
import time
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent
API = "https://api.replicate.com/v1"
VIDEO_MODEL = "bytedance/seedance-2.5"
IMAGE_MODEL = "bytedance/seedream-4.5"
PRICE_PER_SEC = {"480p": 0.1028, "720p": 0.2312}  # Replicate list price, no video input
PRICE_PER_IMAGE = 0.04

TOKEN = os.environ.get("REPLICATE_API_TOKEN") or subprocess.run(
    ["security", "find-generic-password", "-s", "replicate-api-token", "-w"],
    capture_output=True, text=True, check=True,
).stdout.strip()


def request(method, url, body=None, headers=None):
    hdrs = {"Authorization": f"Bearer {TOKEN}", "User-Agent": "reel-gen/1.0"}
    if isinstance(body, dict):
        body = json.dumps(body).encode()
        hdrs["Content-Type"] = "application/json"
    hdrs.update(headers or {})
    for attempt in range(12):
        req = urllib.request.Request(url, data=body, method=method, headers=hdrs)
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            text = e.read().decode()[:500]
            if e.code == 429:  # throttled (low credit: 6/min, burst 1): wait and retry
                try:
                    wait = float(json.loads(text).get("retry_after", 10))
                except ValueError:
                    wait = 10
                time.sleep(wait + 1 + attempt)
                continue
            raise SystemExit(f"{method} {url} → {e.code}: {text}")
    raise SystemExit(f"{method} {url}: still throttled after retries")


def upload(path: Path) -> str:
    """Upload a local file to Replicate's file store and return a URL usable as model input."""
    boundary = uuid.uuid4().hex
    body = (
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"content\"; filename=\"{path.name}\"\r\n"
        f"Content-Type: {mimetypes.guess_type(path.name)[0] or 'application/octet-stream'}\r\n\r\n"
    ).encode() + path.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
    res = request("POST", f"{API}/files", body, {"Content-Type": f"multipart/form-data; boundary={boundary}"})
    return res["urls"]["get"]


def run(model: str, inp: dict, label: str):
    pred = request("POST", f"{API}/models/{model}/predictions", {"input": inp})
    print(f"  {label}: started {pred['id']}", flush=True)
    while pred["status"] not in ("succeeded", "failed", "canceled"):
        time.sleep(5)
        pred = request("GET", pred["urls"]["get"])
    if pred["status"] != "succeeded":
        print(f"  {label}: {pred['status']}: {pred.get('error')}", flush=True)
        return None
    out = pred["output"]
    return out[0] if isinstance(out, list) else out


def download(url: str, dest: Path):
    dest.parent.mkdir(parents=True, exist_ok=True)
    urllib.request.urlretrieve(url, dest)
    print(f"  saved {dest.relative_to(ROOT)}", flush=True)


def ref_file(name):
    for ext in (".png", ".jpg", ".jpeg", ".webp"):
        f = ROOT / "refs" / f"{name}{ext}"
        if f.exists():
            return f
    return None


def load():
    return json.loads((ROOT / "shots.json").read_text())


def selected(cfg, only):
    shots = cfg["shots"]
    if only:
        want = set(only.split(","))
        shots = [s for s in shots if s["id"] in want]
    return shots


def cmd_refs(args):
    cfg = load()
    jobs = []
    style_name = cfg.get("style_ref")
    for name, prompt in cfg["refs"].items():
        existing = ref_file(name)
        # Never overwrite the style reference: everything else is drawn to match it.
        if existing and (not args.force or name == style_name):
            print(f"  {name}: {existing.name} exists, skipping")
            continue
        jobs.append((name, prompt, ROOT / "refs" / f"{name}.png"))
    style_file = ref_file(style_name) if style_name else None
    style_url = upload(style_file) if style_file and jobs else None
    print(f"Generating {len(jobs)} reference images (~${len(jobs) * PRICE_PER_IMAGE:.2f})"
          + (f", in the style of {style_file.name}" if style_url else ""))

    def job(j):
        name, prompt, dest = j
        inp = {"prompt": prompt, "aspect_ratio": "9:16", "size": "2K"}
        if style_url:
            inp["image_input"] = [style_url]
        url = run(IMAGE_MODEL, inp, name)
        if url:
            download(url, dest)

    with ThreadPoolExecutor(4) as pool:
        list(pool.map(job, jobs))


def cmd_shots(args):
    cfg = load()
    shots = selected(cfg, args.only)
    needed = {r for s in shots for r in s["refs"]}
    missing = [r for r in needed if not ref_file(r)]
    if missing:
        raise SystemExit(f"Missing reference images {missing}: run `python3 gen.py refs` first.")
    ref_urls = {r: upload(ref_file(r)) for r in needed}

    jobs = []
    for s in shots:
        for take in range(1, args.takes + 1):
            dest = ROOT / "out" / args.res / f"{s['id']}-{s['name']}-take{take}.mp4"
            if dest.exists():
                print(f"  {dest.name}: exists, skipping")
                continue
            jobs.append((s, take, dest))
    secs = sum(s["duration"] for s, _, _ in jobs)
    print(f"Generating {len(jobs)} clips, {secs}s at {args.res} (~${secs * PRICE_PER_SEC[args.res]:.2f})")

    def job(j):
        s, take, dest = j
        prompt = s["prompt"].format(**{r: f"[Image{i + 1}]" for i, r in enumerate(s["refs"])})
        inp = {
            "prompt": f"{prompt}\n\n{cfg['style']}",
            "reference_images": [ref_urls[r] for r in s["refs"]],
            "duration": s["duration"],
            "resolution": args.res,
            "aspect_ratio": "9:16",
            "generate_audio": True,
        }
        url = run(VIDEO_MODEL, inp, f"{s['id']} take{take}")
        if url:
            download(url, dest)

    with ThreadPoolExecutor(5) as pool:
        list(pool.map(job, jobs))


def cmd_cost(args):
    shots = selected(load(), args.only)
    secs = sum(s["duration"] for s in shots) * args.takes
    print(f"{len(shots)} shots × {args.takes} take(s) = {secs}s at {args.res} ≈ ${secs * PRICE_PER_SEC[args.res]:.2f}")


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("refs")
    r.add_argument("--force", action="store_true", help="regenerate existing reference images")
    for name in ("shots", "cost"):
        s = sub.add_parser(name)
        s.add_argument("--res", default="480p", choices=PRICE_PER_SEC)
        s.add_argument("--only", help="comma-separated shot ids, e.g. s1,s6")
        s.add_argument("--takes", type=int, default=1, help="variations per shot")
    args = p.parse_args()
    {"refs": cmd_refs, "shots": cmd_shots, "cost": cmd_cost}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
