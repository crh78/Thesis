#!/usr/bin/env python3
"""Blind pairs for LLM judges, and the scoreboard once they've answered.

  python3 judge.py pack  [--batches 4]   out/judge/batch-N.json (cases with baskets X and Y in a
                                         random order per case) + out/judge/key.json (which is which)
  python3 judge.py score                 reads out/judge/verdict-N.json and prints win rates, scores
                                         and latency, overall and per category

A verdict file is a JSON list of {"id", "winner": "X"|"Y"|"tie", "x": 1-10, "y": 1-10, "why"}.
"""
import json, random, statistics, sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
J = OUT / "judge"


def load():
    runs = sorted(OUT.glob("*-vs-*.json"))  # the latest run; earlier ones are kept under out/v1, out/v2, …
    return json.loads(runs[-1].read_text())


def pack(batches: int) -> None:
    data = load()
    J.mkdir(parents=True, exist_ok=True)
    rnd = random.Random(7)
    key, items = {}, []
    for r in data["results"]:
        c = r["case"]
        flip = rnd.random() < 0.5
        x, y = (r["b"], r["a"]) if flip else (r["a"], r["b"])
        key[c["id"]] = {"X": "b" if flip else "a", "Y": "a" if flip else "b"}
        strip = lambda s: {k: s[k] for k in ("verdict", "summary", "reason", "note", "error", "legs")}
        items.append({"id": c["id"], "take": c["claim"], "risk": c["risk"], "horizon": c["horizon"],
                      **({"source": c["source"]} if "source" in c else {}), "X": strip(x), "Y": strip(y)})
    rnd.shuffle(items)
    size = -(-len(items) // batches)
    for i in range(batches):
        (J / f"batch-{i + 1}.json").write_text(json.dumps(items[i * size:(i + 1) * size], indent=1))
    (J / "key.json").write_text(json.dumps(key, indent=1))
    print(f"{len(items)} pairs in {batches} batches under {J}")


def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(p / 100 * (len(xs) - 1))))]


def score() -> None:
    data = load()
    key = json.loads((J / "key.json").read_text())
    verdicts = {}
    for f in sorted(J.glob("verdict-*.json")):
        for v in json.loads(f.read_text()):
            verdicts[v["id"]] = v
    names = {"a": data["a"], "b": data["b"]}
    wins = defaultdict(lambda: defaultdict(int))
    scores = defaultdict(lambda: defaultdict(list))
    for r in data["results"]:
        c = r["case"]
        v = verdicts.get(c["id"])
        if not v:
            continue
        k = key[c["id"]]
        winner = "tie" if v["winner"] == "tie" else k[v["winner"]]
        for cat in ("all", c["cat"]):
            wins[cat][winner] += 1
            scores[cat][k["X"]].append(v["x"])
            scores[cat][k["Y"]].append(v["y"])
    print(f"judged {len(verdicts)} of {len(data['results'])}   a = {names['a']}   b = {names['b']}\n")
    print(f"{'category':10} {'n':>3}  {'a wins':>6} {'b wins':>6} {'ties':>5}   {'a score':>7} {'b score':>7}")
    for cat in ["all"] + sorted(k for k in wins if k != "all"):
        w, s = wins[cat], scores[cat]
        n = w["a"] + w["b"] + w["tie"]
        print(f"{cat:10} {n:>3}  {w['a']:>6} {w['b']:>6} {w['tie']:>5}   {statistics.mean(s['a']):>7.2f} {statistics.mean(s['b']):>7.2f}")
    print()
    for side in ("a", "b"):
        wall = [r[side]["wall_ms"] for r in data["results"] if not r[side].get("error")]
        errs = sum(1 for r in data["results"] if r[side].get("error"))
        rules = sum(1 for r in data["results"] if r[side].get("picker") == "rules")
        none = sum(1 for r in data["results"] if r[side].get("verdict") == "no_clean_exposure")
        print(f"{names[side]:18} latency p50 {pct(wall, 50)} ms  p90 {pct(wall, 90)} ms  max {max(wall)} ms   "
              f"errors {errs}  rules fallback {rules}  no basket {none}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "score"
    if cmd == "pack":
        n = int(sys.argv[sys.argv.index("--batches") + 1]) if "--batches" in sys.argv else 4
        pack(n)
    else:
        score()
