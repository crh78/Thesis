// Proxies the app's `social` edge function (follows, suggestions, profile, notifications…) for the
// browser, since it sends no CORS headers. The Privy token passes through; the function verifies it.
// Fork network, like the iOS app's fork builds (`x-thesis-network`).
import { supabaseKey, supabaseUrl } from "@/lib/data";

type Ctx = { params: Promise<{ path: string[] }> };

async function forward(req: Request, { params }: Ctx): Promise<Response> {
  const token = req.headers.get("privy-token");
  if (!token) return Response.json({ error: "invalid_privy_token" }, { status: 401 });
  const { path } = await params;
  if (!path.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) return Response.json({ error: "no_such_route" }, { status: 404 });
  const query = new URL(req.url).search;
  const hasBody = req.method !== "GET" && req.method !== "DELETE";
  const r = await fetch(`${supabaseUrl()}/functions/v1/social/${path.join("/")}${query}`, {
    method: req.method,
    headers: {
      "privy-token": token,
      apikey: supabaseKey(),
      "x-thesis-network": "solana-mainnet-fork",
      ...(hasBody ? { "content-type": "application/json" } : {}),
    },
    body: hasBody ? await req.text() : undefined,
    cache: "no-store",
  });
  return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
}

export const GET = forward;
export const POST = forward;
export const PUT = forward;
export const PATCH = forward;
export const DELETE = forward;
