// quicknode-stream: the QuickNode Stream's webhook. Stores Thesis program events and the
// counters they drive (supabase/migrations/*_chain_events.sql), so the feed, take pages and
// later Scores and notifications reflect the chain.
//
//   POST <body: infra/quicknode/thesis-filter.js output>
//   headers x-qn-nonce, x-qn-timestamp, x-qn-signature (QuickNode's HMAC; see decode.ts)
//   → { ok: true, events: <decoded>, new: <first time seen> }
//
// On mainnet the QuickNode Stream calls it. On the fork, `pnpm fork:relay` with
// THESIS_WEBHOOK_URL=<this function's URL> and THESIS_WEBHOOK_TOKEN=<the same secret> sends the
// same payload (network "solana-mainnet-fork"). Ingesting is idempotent, so retries are harmless.
//
// Secrets: QUICKNODE_STREAM_TOKEN (the Stream's security token; requests aren't accepted without
// it), plus the platform's SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { decodeStream, verifySignature } from "./decode.ts";

const TOKEN = Deno.env.get("QUICKNODE_STREAM_TOKEN");
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  if (!TOKEN) return json(503, { error: "not_configured" });
  const body = await req.text();
  if (body.length > 5_000_000) return json(413, { error: "too_large" });
  if (!(await verifySignature(req.headers, body, TOKEN))) return json(401, { error: "bad_signature" });

  let byNetwork;
  try {
    byNetwork = decodeStream(body);
  } catch (e) {
    // Not retryable: a malformed or foreign payload won't decode on the next try either.
    return json(400, { error: "bad_payload", message: e instanceof Error ? e.message : String(e) });
  }

  let events = 0;
  let fresh = 0;
  for (const [network, list] of byNetwork) {
    if (!list.length) continue;
    const { data, error } = await db.rpc("ingest_chain_events", { p_network: network, p_events: list });
    // A 5xx makes QuickNode (and the relay) retry the batch.
    if (error) return json(500, { error: "ingest_failed", message: error.message });
    events += list.length;
    fresh += Number(data ?? 0);
  }
  return json(200, { ok: true, events, new: fresh });
});
