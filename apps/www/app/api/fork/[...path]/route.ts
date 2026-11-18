// The browser's way to the fork API when NEXT_PUBLIC_FORK_API_URL isn't set (with it, lib/fork.ts
// calls the fork API directly, through its CORS origins, and this route is only kept for
// compatibility; no server code calls it). A server route rather than a rewrite, so it can add
// what only the server may know (the fork API's abuse guard):
//   x-thesis-proxy-key   FORK_API_PROXY_KEY, the secret the fork API shares with this proxy
//   x-thesis-client-ip   the visitor's IP (Vercel sets x-real-ip / x-forwarded-for and overwrites
//                        anything a client sends), so rate limits count each visitor, not Vercel
// The browser's own Authorization (its Privy token, on money calls) and x-thesis-wallet-auth
// (creator fees) pass through. Neither proxy header ever comes from the browser.
import { forkApiUrl } from "@/lib/data";

type Ctx = { params: Promise<{ path: string[] }> };

const PASS = ["content-type", "authorization", "x-thesis-wallet-auth"];

async function forward(req: Request, { params }: Ctx): Promise<Response> {
  const { path } = await params;
  // Plain segments only: no "." or ".." (they could walk out of the fork API's paths).
  if (!path.every((p) => /^[A-Za-z0-9_:.-]+$/.test(p) && p !== "." && p !== "..")) return Response.json({ error: "no_such_route" }, { status: 404 });
  const headers: Record<string, string> = {};
  for (const h of PASS) {
    const v = req.headers.get(h);
    if (v) headers[h] = v;
  }
  const key = process.env.FORK_API_PROXY_KEY;
  const ip = req.headers.get("x-real-ip") ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (key && ip) {
    headers["x-thesis-proxy-key"] = key;
    headers["x-thesis-client-ip"] = ip;
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const base = forkApiUrl(); // outside the try: a missing FORK_API_URL is a setup error, not "unreachable"
  let r: Response;
  try {
    r = await fetch(`${base}/${path.join("/")}${new URL(req.url).search}`, {
      method: req.method,
      headers,
      body: hasBody ? await req.text() : undefined,
      cache: "no-store",
    });
  } catch {
    return Response.json({ error: "fork_unreachable", message: "Can't reach Thesis right now. Try again in a moment." }, { status: 502 });
  }
  const out = new Headers({ "content-type": r.headers.get("content-type") ?? "application/json" });
  const retry = r.headers.get("retry-after");
  if (retry) out.set("retry-after", retry);
  return new Response(await r.text(), { status: r.status, headers: out });
}

export const GET = forward;
export const POST = forward;
// Trades and posts run Jupiter routing on the fork API (and wait in its build queue when busy).
export const maxDuration = 60;
