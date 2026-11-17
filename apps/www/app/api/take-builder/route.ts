// Proxies the app's `take-builder` edge function (build a basket for a take, edit it in plain words,
// or move it to a new risk), since it sends no CORS headers. GET wakes it while you write. The Privy
// token passes through and the function checks it.
import { supabaseKey, supabaseUrl } from "@/lib/data";

async function forward(req: Request): Promise<Response> {
  const token = req.headers.get("privy-token");
  if (!token) return Response.json({ error: "invalid_privy_token" }, { status: 401 });
  const r = await fetch(`${supabaseUrl()}/functions/v1/take-builder`, {
    method: req.method,
    headers: { "privy-token": token, apikey: supabaseKey(), "content-type": "application/json", "x-thesis-network": "solana-mainnet-fork" },
    body: req.method === "POST" ? await req.text() : undefined,
    cache: "no-store",
  });
  return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
}

export const GET = forward;
export const POST = forward;
// Builds take a few seconds (one model call, sometimes two).
export const maxDuration = 60;
