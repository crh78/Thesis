// Proxies the web-push function's subscribe routes for the browser (POST saves this browser's push
// subscription, DELETE forgets it). The Privy token passes through; the function checks it.
import { supabaseKey, supabaseUrl } from "@/lib/data";

type Ctx = { params: Promise<{ path: string[] }> };

async function forward(req: Request, { params }: Ctx): Promise<Response> {
  const token = req.headers.get("privy-token");
  if (!token) return Response.json({ error: "invalid_privy_token" }, { status: 401 });
  const { path } = await params;
  if (path.join("/") !== "subscribe") return Response.json({ error: "no_such_route" }, { status: 404 });
  const r = await fetch(`${supabaseUrl()}/functions/v1/web-push/subscribe`, {
    method: req.method,
    headers: { "privy-token": token, apikey: supabaseKey(), "content-type": "application/json", "user-agent": req.headers.get("user-agent") ?? "" },
    body: await req.text(),
    cache: "no-store",
  });
  return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
}

export const POST = forward;
export const DELETE = forward;
