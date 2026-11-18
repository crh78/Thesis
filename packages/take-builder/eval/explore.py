#!/usr/bin/env python3
"""Many builders at once: every case through each variant, then blind listwise judging.

  python3 explore.py run   [--concurrency 2] [--only 001,002] [--variants v10,agent]   out/explore.json
                           (resumes: reruns only what a case is missing or what errored)
  python3 explore.py pack  [--batches 5]                        out/explore-judge/batch-N.json + key.json
  python3 explore.py score                                       needs out/explore-judge/verdict-N.json

Variants (VARIANTS below) are the deployed gte builder and take-builder-next run with an admin-only
`variant` option (see Variant in supabase/functions/take-builder/index.ts): no listed catalog, no
up-front market search, more search rounds, a Postgres search instead of the in-memory index,
reasoning on. A verdict file is a JSON list of {"id", "scores": {"A": 1-10, ...}, "why"}.
"""
import json, random, statistics, sys, time
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import run as R  # call(), secret(), warm(), slim()

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
J = OUT / "explore-judge"

AGENTIC = {"rounds": 8, "speculate": False, "timeoutMs": 30000}
VARIANTS = {
    "gte": ("take-builder", None),                                   # live: gte-small embeddings + one call
    "v10": ("take-builder-next", {}),                                # listed + markets + 1 search round, speculative
    "listed-agent": ("take-builder-next", {**AGENTIC}),              # listed + markets, up to 8 rounds
    "agent": ("take-builder-next", {**AGENTIC, "listed": False, "markets": False}),  # search tool only (BM25), up to 8 rounds
    "agent-markets": ("take-builder-next", {**AGENTIC, "listed": False}),            # search tool + up-front markets
    "agent-db": ("take-builder-next", {**AGENTIC, "listed": False, "markets": False, "search": "db"}),  # no index: Postgres search
    "v10-reasoning": ("take-builder-next", {"reasoning": "low", "timeoutMs": 20000}),  # v10 with reasoning low
}


def run(concurrency: int, only: set[str], wanted: list[str]) -> None:
    sec = R.secret()
    cases = [c for c in json.loads((HERE / "cases.json").read_text()) if not only or c["id"] in only]
    # Resumable: results are kept in out/explore.jsonl (a line per case run; later lines add to
    # earlier ones). A rerun only runs the variants a case is missing or that errored.
    OUT.mkdir(exist_ok=True)
    partial = OUT / "explore.jsonl"
    done: dict[str, dict] = {}
    for l in (partial.read_text().splitlines() if partial.exists() else []):
        row = json.loads(l)
        done.setdefault(row["case"]["id"], {"case": row["case"], "by": {}})["by"].update(row["by"])
    names = wanted or list(VARIANTS)
    missing = lambda c: [n for n in names if n not in done.get(c["id"], {}).get("by", {}) or done[c["id"]]["by"][n].get("error")]
    todo = [c for c in cases if missing(c)]
    print(f"{len(todo)} cases to run ({', '.join(names)})", flush=True)
    for fn in {fn for fn, _ in VARIANTS.values()}:
        R.warm(fn, sec)

    def one(case: dict) -> dict:
        body = {k: case[k] for k in ("claim", "risk", "source") if k in case}
        def go(item):
            name, (fn, variant) = item
            reply = R.call(fn, {**body, **({"variant": variant} if variant is not None else {})}, sec)
            dbg = reply.get("debug") if isinstance(reply.get("debug"), dict) else {}
            return name, {**R.slim(reply), "wall_ms": reply["wall_ms"], "picker": reply.get("picker"),
                          "rounds": dbg.get("rounds"), "searches": len(dbg.get("searches") or [])}
        items = [(n, VARIANTS[n]) for n in missing(case)]
        random.shuffle(items)
        with ThreadPoolExecutor(len(items)) as pool:
            got = dict(pool.map(go, items))
        print(case["id"], " ".join(f"{n}:{got[n]['wall_ms']}" + ("!" if got[n].get("error") else "") for n in got), flush=True)
        row = {"case": case, "by": got}
        with partial.open("a") as f:
            f.write(json.dumps(row) + "\n")
        return row

    with ThreadPoolExecutor(concurrency) as pool:
        for row in pool.map(one, todo):
            done.setdefault(row["case"]["id"], {"case": row["case"], "by": {}})["by"].update(row["by"])
    results = [done[c["id"]] for c in cases if c["id"] in done]
    (OUT / "explore.json").write_text(json.dumps({"variants": list(VARIANTS), "results": results}, indent=1))
    print("wrote", OUT / "explore.json")


def merged() -> dict:
    """All results so far, from out/explore.jsonl (later lines add to earlier ones)."""
    done: dict[str, dict] = {}
    for l in (OUT / "explore.jsonl").read_text().splitlines():
        row = json.loads(l)
        done.setdefault(row["case"]["id"], {"case": row["case"], "by": {}})["by"].update(row["by"])
    order = [c["id"] for c in json.loads((HERE / "cases.json").read_text())]
    return {"variants": list(VARIANTS), "results": [done[i] for i in order if i in done]}


def pack(batches: int, only: list[str], tag: str) -> None:
    data = merged()
    if only:
        data["variants"] = only
        for r in data["results"]:
            r["by"] = {n: x for n, x in r["by"].items() if n in only}
    (OUT / f"explore{tag}.json").write_text(json.dumps(data, indent=1))
    jd = OUT / f"explore-judge{tag}"
    jd.mkdir(parents=True, exist_ok=True)
    rnd = random.Random(11)
    key, items = {}, []
    for r in data["results"]:
        names = list(r["by"])
        rnd.shuffle(names)
        labels = [chr(65 + i) for i in range(len(names))]
        key[r["case"]["id"]] = dict(zip(labels, names))
        c = r["case"]
        strip = lambda s: {k: s.get(k) for k in ("verdict", "summary", "reason", "error", "legs")}
        items.append({"id": c["id"], "take": c["claim"], "risk": c["risk"],
                      **({"source": c["source"]} if "source" in c else {}),
                      "baskets": {l: strip(r["by"][n]) for l, n in zip(labels, names)}})
    rnd.shuffle(items)
    size = -(-len(items) // batches)
    for i in range(batches):
        (jd / f"batch-{i + 1}.json").write_text(json.dumps(items[i * size:(i + 1) * size], indent=1))
    (jd / "key.json").write_text(json.dumps(key, indent=1))
    print(f"{len(items)} cases, {len(data['variants'])} baskets each, in {batches} batches under {jd}")


def pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(round(p / 100 * (len(xs) - 1))))] if xs else 0


def score(tag: str) -> None:
    data = json.loads((OUT / f"explore{tag}.json").read_text())
    jd = OUT / f"explore-judge{tag}"
    key = json.loads((jd / "key.json").read_text())
    verdicts = {}
    for f in sorted(jd.glob("verdict-*.json")):
        for v in json.loads(f.read_text()):
            verdicts[v["id"]] = v
    names = data["variants"]
    scores = defaultdict(list)
    by_cat = defaultdict(lambda: defaultdict(list))
    beats_gte = defaultdict(lambda: [0, 0, 0])  # wins, ties, losses vs gte
    for r in data["results"]:
        v = verdicts.get(r["case"]["id"])
        if not v:
            continue
        k = key[r["case"]["id"]]
        s = {k[l]: v["scores"][l] for l in v["scores"] if l in k}
        for n, x in s.items():
            scores[n].append(x)
            by_cat[r["case"]["cat"]][n].append(x)
            if n != "gte" and "gte" in s:
                d = x - s["gte"]
                beats_gte[n][0 if d > 0 else 1 if d == 0 else 2] += 1
    print(f"judged {len(verdicts)} of {len(data['results'])}\n")
    print(f"{'variant':15} {'score':>5}  {'vs gte W-T-L':>13}  {'p50':>6} {'p90':>6} {'mean':>6}  {'rounds':>6} {'searches':>8}  errors none")
    for n in sorted(names, key=lambda n: -statistics.mean(scores[n] or [0])):
        rows = [r["by"][n] for r in data["results"]]
        wall = [x["wall_ms"] for x in rows if not x.get("error")]
        w, t, l = beats_gte[n]
        rounds = [x["rounds"] for x in rows if x.get("rounds")]
        print(f"{n:15} {statistics.mean(scores[n] or [0]):>5.2f}  {'' if n == 'gte' else f'{w}-{t}-{l}':>13}  "
              f"{pct(wall, 50):>6} {pct(wall, 90):>6} {round(statistics.mean(wall)) if wall else 0:>6}  "
              f"{statistics.mean(rounds) if rounds else 0:>6.2f} {statistics.mean([x['searches'] for x in rows]):>8.2f}  "
              f"{sum(1 for x in rows if x.get('error')):>6} {sum(1 for x in rows if x.get('verdict') == 'no_clean_exposure'):>4}")
    print("\nby category (mean score):")
    print(f"{'':10}" + "".join(f"{n[:13]:>14}" for n in names))
    for cat in sorted(by_cat):
        print(f"{cat:10}" + "".join(f"{statistics.mean(by_cat[cat][n] or [0]):>14.2f}" for n in names))


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "score"
    arg = lambda flag, d: sys.argv[sys.argv.index(flag) + 1] if flag in sys.argv else d
    if cmd == "run":
        run(int(arg("--concurrency", "2")), set(filter(None, arg("--only", "").split(","))),
            [v for v in arg("--variants", "").split(",") if v])
    elif cmd == "pack":
        pack(int(arg("--batches", "5")), [v for v in arg("--variants", "").split(",") if v], arg("--tag", ""))
    else:
        score(arg("--tag", ""))
