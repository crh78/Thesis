#!/usr/bin/env python3
"""Generate music beds with Lyria 2 on Replicate (~$0.06 per ~30s clip). Token from $REPLICATE_API_TOKEN or the macOS Keychain."""
import json, os, subprocess, sys, time, urllib.request
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
TOKEN = os.environ.get("REPLICATE_API_TOKEN") or subprocess.run(["security", "find-generic-password", "-s", "replicate-api-token", "-w"], capture_output=True, text=True, check=True).stdout.strip()
H = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json", "User-Agent": "reel-gen/1.0"}
NEG = "vocals, singing, lyrics, speech, voice, choir"
OPTIONS = {
    "1-launch": "Modern tech product launch music, instrumental. Minimal electronic, warm analog synth pads, punchy kick and crisp claps at 118 BPM, bright plucked arpeggio, confident, optimistic and building, sleek like an Apple or Stripe keynote.",
    "2-lofi": "Upbeat lo-fi hip hop instrumental, bouncy boom-bap drums at 92 BPM, warm Rhodes chords, deep sub bass, vinyl crackle, playful and catchy, chill but energetic, modern social media vibe.",
    "3-cinematic": "Cinematic tech trailer instrumental, pulsing synth arpeggios, deep driving bass, rising tension with big drums, dark and dramatic but hopeful, futuristic, 120 BPM.",
}
def req(method, url, body=None):
    for i in range(12):
        r = urllib.request.Request(url, data=json.dumps(body).encode() if body else None, method=method, headers=H)
        try:
            with urllib.request.urlopen(r, timeout=120) as resp: return json.load(resp)
        except urllib.error.HTTPError as e:
            t = e.read().decode()
            if e.code == 429: time.sleep(12 + i); continue
            raise SystemExit(f"{e.code}: {t[:300]}")
def run(item):
    name, prompt = item
    p = req("POST", "https://api.replicate.com/v1/models/google/lyria-2/predictions", {"input": {"prompt": prompt, "negative_prompt": NEG}})
    print(f"{name}: started {p['id']}", flush=True)
    while p["status"] not in ("succeeded", "failed", "canceled"):
        time.sleep(4); p = req("GET", p["urls"]["get"])
    if p["status"] != "succeeded": print(f"{name}: {p['status']} {p.get('error')}", flush=True); return
    out = p["output"][0] if isinstance(p["output"], list) else p["output"]
    dest = Path(__file__).resolve().parent / "music" / f"{name}.wav"; urllib.request.urlretrieve(out, dest); print(f"{name}: saved {dest}", flush=True)
with ThreadPoolExecutor(1) as pool: list(pool.map(run, OPTIONS.items()))
