// Proxies the `agent` edge function's routes for the limits screen (/limits) and copy trading
// (/copy), since they're called from the browser: GET / PUT / DELETE grant (your limits for trading
// by text), GET links/<token> (who an iMessage connect link connects), and copies (who you copy and
// the auto-copy settings). The bots' routes stay off the web. The Privy token
// passes through and the function checks it.
import { supabaseKey, supabaseUrl } from "@/lib/data";

type Ctx = { params: Promise<{ path: string[] }> };

async function forward(req: Request, { params }: Ctx): Promise<Response> {
  const { path } = await params;
  const grant = path.length === 1 && path[0] === "grant" && ["GET", "PUT", "DELETE"].includes(req.method);
  const link = path.length === 2 && path[0] === "links" && /^[A-Za-z0-9_-]{16,64}$/.test(path[1]) && req.method === "GET";
  // Copy trading: GET copies; PUT / DELETE copies/x/<handle> and copies/trader/<profile id>.
  const copies = path[0] === "copies" && (
    (path.length === 1 && req.method === "GET") ||
    (path.length === 3 && ["PUT", "DELETE"].includes(req.method) &&
      ((path[1] === "x" && /^[A-Za-z0-9_]{1,15}$/.test(path[2])) || (path[1] === "trader" && /^[0-9a-f-]{36}$/i.test(path[2])))));
  if (!grant && !link && !copies) return Response.json({ error: "no_such_route" }, { status: 404 });
  const token = req.headers.get("privy-token");
  if ((grant || copies) && !token) return Response.json({ error: "invalid_privy_token" }, { status: 401 });
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
