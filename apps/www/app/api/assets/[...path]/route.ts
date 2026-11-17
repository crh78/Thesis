// Proxies the app's `assets` edge function (search what you can buy, asset pages) for the browser,
// since it sends no CORS headers. Reads only; the Privy token passes through and the function checks it.
import { supabaseKey, supabaseUrl } from "@/lib/data";

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(req: Request, { params }: Ctx): Promise<Response> {
  const token = req.headers.get("privy-token");
  if (!token) return Response.json({ error: "invalid_privy_token" }, { status: 401 });
  const { path } = await params;
  // Plain segments only: no "." or ".." (they could walk out of the function's path).
  if (!path.every((p) => /^[A-Za-z0-9_:.-]+$/.test(p) && p !== "." && p !== "..")) return Response.json({ error: "no_such_route" }, { status: 404 });
  const r = await fetch(`${supabaseUrl()}/functions/v1/assets/${path.join("/")}${new URL(req.url).search}`, {
    headers: { "privy-token": token, apikey: supabaseKey(), "x-thesis-network": "solana-mainnet-fork" },
    cache: "no-store",
  });
  return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
}
