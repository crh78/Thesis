// Proxies the `agent` edge function's routes for the limits screen (/limits), since it's called
// from the browser: GET / PUT / DELETE grant (your limits for trading by text) and GET links/<token>
// (who an iMessage connect link connects). The bots' routes stay off the web. The Privy token
// passes through and the function checks it.
import { supabaseKey, supabaseUrl } from "@/lib/data";

type Ctx = { params: Promise<{ path: string[] }> };

async function forward(req: Request, { params }: Ctx): Promise<Response> {
  const { path } = await params;
  const grant = path.length === 1 && path[0] === "grant" && ["GET", "PUT", "DELETE"].includes(req.method);
  const link = path.length === 2 && path[0] === "links" && /^[A-Za-z0-9_-]{16,64}$/.test(path[1]) && req.method === "GET";
  if (!grant && !link) return Response.json({ error: "no_such_route" }, { status: 404 });
  const token = req.headers.get("privy-token");
  if (grant && !token) return Response.json({ error: "invalid_privy_token" }, { status: 401 });
  const hasBody = req.method === "PUT";
  const r = await fetch(`${supabaseUrl()}/functions/v1/agent/${path.join("/")}`, {
    method: req.method,
    headers: { apikey: supabaseKey(), ...(token ? { "privy-token": token } : {}), ...(hasBody ? { "content-type": "application/json" } : {}) },
    body: hasBody ? await req.text() : undefined,
    cache: "no-store",
  });
  return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
}

export const GET = forward;
export const PUT = forward;
export const DELETE = forward;
