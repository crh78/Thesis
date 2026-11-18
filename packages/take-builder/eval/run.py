#!/usr/bin/env python3
"""A/B the take builder: every case in cases.json through two deployed functions.

  python3 run.py [--a take-builder] [--b take-builder-next] [--concurrency 4] [--only 001,002]

Calls each function under SUPABASE_URL as admin (x-index-secret = SECURITIES_INDEX_SECRET; both from
the environment, the repo-root .env or supabase/functions/.env, never printed),
both builders on the same case at the same time, and writes out/<a>-vs-<b>.json with each
reply, its wall-clock latency and the server's own `ms`. judge.py turns that into blind pairs.
"""
import argparse, json, os, random, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent


def setting(name: str) -> str:
    """A setting from the environment, else the nearest .env or supabase/functions/.env walking up."""
    if os.environ.get(name):
        return os.environ[name]
    for d in [HERE, *HERE.parents]:
        for env in [d / ".env", d / "supabase/functions/.env"]:
            if env.exists():
                for line in env.read_text().splitlines():
                    if line.startswith(name + "="):
                        return line.split("=", 1)[1].strip().strip('"')
    raise SystemExit(f"{name} not set (environment, repo-root .env or supabase/functions/.env)")


def functions_url() -> str:
    return setting("SUPABASE_URL").rstrip("/") + "/functions/v1/"


def secret() -> str:
    return setting("SECURITIES_INDEX_SECRET")


def call(fn: str, body: dict, sec: str) -> dict:
    req = urllib.request.Request(functions_url() + fn, data=json.dumps(body).encode(), method="POST",
                                 headers={"x-index-secret": sec, "content-type": "application/json"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            out = json.loads(r.read())
    except urllib.error.HTTPError as e:
        out = {"error": f"http {e.code}", "body": e.read().decode()[:300]}
    except Exception as e:  # timeouts, resets
        out = {"error": str(e)}
    out["wall_ms"] = round((time.time() - t0) * 1000)
    return out


def warm(fn: str, sec: str) -> None:
    req = urllib.request.Request(functions_url() + fn, headers={"x-index-secret": sec})
    try:
        urllib.request.urlopen(req, timeout=60).read()
    except Exception:
        pass


def slim(reply: dict) -> dict:
    """What a judge needs, without debug noise."""
    return {
        "verdict": reply.get("verdict"), "summary": reply.get("summary"), "reason": reply.get("reason"),
        "note": reply.get("note"), "error": reply.get("error"),
        "legs": [{"name": l["name"], "kind": l["kind"], "side": l["side"], "weight": l["weight"],
                  "leverage": l.get("leverage", 1), "why": l["why"]} for l in reply.get("legs", [])],
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--a", default="take-builder")
    ap.add_argument("--b", default="take-builder-next")
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--only", default="")
    ap.add_argument("--system", default="", help="file with a system prompt for --b to try (admin override)")
    ap.add_argument("--tag", default="", help="suffix for the output file")
    args = ap.parse_args()
    sec = secret()
    system = Path(args.system).read_text() if args.system else ""
    cases = json.loads((HERE / "cases.json").read_text())
    if args.only:
        keep = set(args.only.split(","))
        cases = [c for c in cases if c["id"] in keep]
    for fn in (args.a, args.b):
        warm(fn, sec)

    def run(case: dict) -> dict:
        body = {k: case[k] for k in ("claim", "risk", "source") if k in case}
        body_b = {**body, "system": system} if system else body
        # Both at once, so neither gets a quieter moment; order shuffled per case.
        fns = [args.a, args.b]
        random.shuffle(fns)
        with ThreadPoolExecutor(2) as pool:
            replies = dict(zip(fns, pool.map(lambda fn: call(fn, body_b if fn == args.b else body, sec), fns)))
        a, b = replies[args.a], replies[args.b]
        print(f"{case['id']} {case['cat']:8} a {a['wall_ms']:>5}ms {a.get('picker') or a.get('error')!s:12} "
              f"b {b['wall_ms']:>5}ms {b.get('picker') or b.get('error')!s:12} {case['claim'][:50]}", flush=True)
        return {"case": case,
                "a": {**slim(a), "wall_ms": a["wall_ms"], "server_ms": a.get("ms"), "picker": a.get("picker")},
                "b": {**slim(b), "wall_ms": b["wall_ms"], "server_ms": b.get("ms"), "picker": b.get("picker"),
                      "searches": (b.get("debug") or {}).get("searches")}}

    with ThreadPoolExecutor(args.concurrency) as pool:
        results = list(pool.map(run, cases))
    out = HERE / "out"
    out.mkdir(exist_ok=True)
    path = out / f"{args.a}-vs-{args.b}{'-' + args.tag if args.tag else ''}.json"
    path.write_text(json.dumps({"a": args.a, "b": args.b, "results": results}, indent=1))
    print("wrote", path)


if __name__ == "__main__":
    main()
