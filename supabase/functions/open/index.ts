// open: https link → Thesis app deep link.
//
// iMessage only makes https links tappable, and the app can't use universal
// links yet (free Apple team, no Associated Domains). So chat links point here
// and get a 302 into the app's URL scheme:
//
//   GET /open?app=dev&claim=…&risk=medium
//   → 302 yourthesis-dev://take/new?claim=…&risk=medium
//
// The app opens the take straight on the built basket (CreateFlow). Only the
// take fields pass through, so this can't redirect anywhere else. Takes have no
// horizon any more (they run until the author sells), so an old link's horizon
// is dropped.

const SCHEMES = { dev: "yourthesis-dev", prod: "yourthesis" } as const;
const RISKS = new Set(["low", "medium", "high"]);

Deno.serve((req) => {
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405 });
  const q = new URL(req.url).searchParams;
  const scheme = q.get("app") === "prod" ? SCHEMES.prod : SCHEMES.dev;

  const claim = (q.get("claim") ?? "").trim().slice(0, 280);
  if (claim.length < 5) return new Response("missing take", { status: 400 });
  const out: [string, string][] = [["claim", claim]];
  const risk = q.get("risk") ?? "";
  if (RISKS.has(risk)) out.push(["risk", risk]);
  // %20, not URLSearchParams' "+": iOS URLComponents reads "+" literally.
  const query = out.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");

  return new Response(null, {
    status: 302,
    headers: { location: `${scheme}://take/new?${query}`, "cache-control": "no-store" },
  });
});
