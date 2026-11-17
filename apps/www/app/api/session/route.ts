// Proxies the app's `session` edge function (Privy login → Thesis profile) for the browser, since the
// function sends no CORS headers. The Privy token passes through untouched; the function verifies it.
// POST carries a profile photo (JPEG or PNG bytes, up to 3 MB; the function checks).
import { supabaseKey, supabaseUrl } from "@/lib/data";

async function forward(req: Request): Promise<Response> {
  const token = req.headers.get("privy-token");
  if (!token) return Response.json({ error: "invalid_privy_token" }, { status: 401 });
  const headers: Record<string, string> = { "privy-token": token, apikey: supabaseKey() };
  let body: BodyInit | undefined;
  if (req.method === "PATCH" || req.method === "DELETE") {
    headers["content-type"] = "application/json";
    body = await req.text();
  } else if (req.method === "POST") {
    headers["content-type"] = req.headers.get("content-type") ?? "application/octet-stream";
    body = await req.arrayBuffer();
  }
  const r = await fetch(`${supabaseUrl()}/functions/v1/session`, { method: req.method, headers, body, cache: "no-store" });
  return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
}

export const GET = forward;
export const PATCH = forward;
export const POST = forward;
// DELETE { confirm: "delete" } deletes the account for good (Settings → Delete account).
export const DELETE = forward;
