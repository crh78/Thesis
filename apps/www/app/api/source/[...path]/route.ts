// Proxies the app's `source` edge function for copying X accounts (GET x, PUT and DELETE
// x/<handle>), crediting a new take to where it came from (POST attach) and marking a chat bot's
// draft as posted (PUT drafts/<id>), since it sends no CORS headers. Only those routes: the
// article, poll and bot routes stay off the web. The Privy token passes through and the function checks it.
import { supabaseKey, supabaseUrl } from "@/lib/data";

type Ctx = { params: Promise<{ path: string[] }> };

async function forward(req: Request, { params }: Ctx): Promise<Response> {
  const token = req.headers.get("privy-token");
  if (!token) return Response.json({ error: "invalid_privy_token" }, { status: 401 });
  const { path } = await params;
  const attach = path.length === 1 && path[0] === "attach" && req.method === "POST";
  const posted = path.length === 2 && path[0] === "drafts" && /^[A-Za-z0-9]{8}$/.test(path[1]) && req.method === "PUT";
  const ok = attach || posted || (path[0] === "x" && (path.length === 1 ? req.method === "GET" : path.length === 2 && /^[A-Za-z0-9_]{1,15}$/.test(path[1]) && req.method !== "GET"));
  if (!ok) return Response.json({ error: "no_such_route" }, { status: 404 });
  const hasBody = attach || posted;
  const r = await fetch(`${supabaseUrl()}/functions/v1/source/${path.join("/")}`, {
    method: req.method,
    headers: { "privy-token": token, apikey: supabaseKey(), ...(hasBody ? { "content-type": "application/json" } : {}) },
    body: hasBody ? await req.text() : undefined,
    cache: "no-store",
  });
  return new Response(await r.text(), { status: r.status, headers: { "content-type": "application/json" } });
}

export const GET = forward;
export const PUT = forward;
export const DELETE = forward;
export const POST = forward;
