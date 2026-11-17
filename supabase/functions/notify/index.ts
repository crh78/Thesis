// notify: notifications the backend computes, posted into the inbox (migrations/*_notifications.sql).
// The fork API (and later the mainnet backend) knows what each wallet's positions are worth and
// how close its leveraged legs are to liquidation; Supabase doesn't.
//
//   POST { network, day: "YYYY-MM-DD", digests: [{ wallet, title, body, data? }] }
//        the daily positions digest: one per profile per network per day
//   POST { network, alerts: [{ wallet, key, take_id?, title, body, data? }] }
//        liquidation warnings (migrations/*_liquidation_alerts.sql): one per profile per key
//        ("<position>:<leg>:near" or ":close"), however often the watcher sends it
//   headers x-qn-nonce, x-qn-timestamp, x-qn-signature (see ../_shared/hmac.ts), keyed NOTIFY_TOKEN
//   → { ok: true, stored: <new notifications> }
//
// Wallets with no profile are skipped.
//
// Secrets: NOTIFY_TOKEN (the backend's signing secret), plus the platform's SUPABASE_URL /
// SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { verifySignature } from "../_shared/hmac.ts";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type Digest = { wallet: string; title: string; body: string; data?: Record<string, unknown> };
type Alert = { wallet: string; key: string; takeId: string | null; title: string; body: string; data: Record<string, unknown> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Parsed =
  | { kind: "digests"; network: string; day: string; digests: Digest[] }
  | { kind: "alerts"; network: string; alerts: Alert[] };

export function parse(body: unknown): Parsed | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.network !== "string" || !b.network) return null;
  if (Array.isArray(b.alerts)) {
    if (b.alerts.length > 1000) return null;
    const alerts: Alert[] = [];
    for (const a of b.alerts) {
      if (!a || typeof a.wallet !== "string" || typeof a.key !== "string" || !a.key || typeof a.title !== "string" || !a.title) return null;
      alerts.push({
        wallet: a.wallet,
        key: a.key,
        takeId: typeof a.take_id === "string" && UUID.test(a.take_id) ? a.take_id : null,
        title: a.title,
        body: typeof a.body === "string" ? a.body : "",
        data: a.data && typeof a.data === "object" ? a.data : {},
      });
    }
    return { kind: "alerts", network: b.network, alerts };
  }
  if (typeof b.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(b.day)) return null;
  if (!Array.isArray(b.digests) || b.digests.length > 1000) return null;
  const digests: Digest[] = [];
  for (const d of b.digests) {
    if (!d || typeof d.wallet !== "string" || typeof d.title !== "string" || !d.title) return null;
    digests.push({ wallet: d.wallet, title: d.title, body: typeof d.body === "string" ? d.body : "", data: d.data && typeof d.data === "object" ? d.data : {} });
  }
  return { kind: "digests", network: b.network, day: b.day, digests };
}

if (import.meta.main) {
  const TOKEN = Deno.env.get("NOTIFY_TOKEN");
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  Deno.serve(async (req) => {
    if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
    if (!TOKEN) return json(503, { error: "not_configured" });
    const raw = await req.text();
    if (raw.length > 1_000_000) return json(413, { error: "too_large" });
    if (!(await verifySignature(req.headers, raw, TOKEN))) return json(401, { error: "bad_signature" });
    let parsed: Parsed | null;
    try {
      parsed = parse(JSON.parse(raw));
    } catch {
      parsed = null;
    }
    if (!parsed) return json(400, { error: "bad_payload" });

    let stored = 0;
    if (parsed.kind === "alerts") {
      for (const a of parsed.alerts) {
        const { data, error } = await db.rpc("post_liquidation_alert", {
          p_wallet: a.wallet, p_network: parsed.network, p_key: a.key, p_take: a.takeId, p_title: a.title, p_body: a.body, p_data: a.data,
        });
        if (error) return json(500, { error: "store_failed", message: error.message });
        if (data) stored++;
      }
      return json(200, { ok: true, stored });
    }
    for (const d of parsed.digests) {
      const { data, error } = await db.rpc("post_daily_positions", {
        p_wallet: d.wallet, p_network: parsed.network, p_day: parsed.day, p_title: d.title, p_body: d.body, p_data: d.data,
      });
      if (error) return json(500, { error: "store_failed", message: error.message });
      if (data) stored++;
    }
    return json(200, { ok: true, stored });
  });
}
