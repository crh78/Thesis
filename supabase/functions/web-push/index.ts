// web-push: notifications as web push, for the web app (apps/www) added to a phone's home screen.
//
//   POST   /web-push/subscribe  { endpoint, keys: { p256dh, auth } }  save this browser for the
//                               signed-in person (header privy-token) → { saved: true }. An endpoint
//                               already saved moves to whoever signed in on that browser last.
//   DELETE /web-push/subscribe  { endpoint }  forget this browser → { removed: true }
//   POST   /web-push/send       { notification_id }  header x-push-secret (the Vault's
//                               web_push_secret, sent by the notifications_web_push trigger in
//                               migrations/*_web_push.sql): push that notification to its person's
//                               browsers. Browsers the push service says are gone (404/410) are
//                               removed. → { sent, removed }
//
// Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (a mailto: or https URL), PRIVY_* for
// the token, plus the platform's SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY. A tap opens a path on the
// app's own origin (no WEB_URL needed). /send answers 503 if the Vault has no web_push_secret.

import { createClient } from "jsr:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";
import { privyDid } from "../_shared/privy.ts";
import { type Note, parseSubscription, payload, sameSecret } from "./push.ts";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT") ?? "https://thesis-www.vercel.app",
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

let secret: string | null = null;
/** The Vault's web_push_secret (cached), or null if it isn't configured. */
const pushSecret = async (): Promise<string | null> => {
  if (secret) return secret;
  const { data, error } = await db.rpc("web_push_secret");
  if (error) throw error;
  secret = typeof data === "string" && data.length >= 16 ? data : null;
  return secret;
};

Deno.serve(async (req) => {
  const route = new URL(req.url).pathname.split("/").filter(Boolean).slice(-1)[0];
  try {
    if (route === "send" && req.method === "POST") {
      const expected = await pushSecret();
      if (!expected) return json(503, { error: "not_configured" });
      if (!sameSecret(req.headers.get("x-push-secret"), expected)) return json(401, { error: "unauthorized" });
      const { notification_id } = await req.json().catch(() => ({}));
      if (!Number.isInteger(notification_id)) return json(400, { error: "invalid_notification_id" });
      const { data: n } = await db.from("notifications").select("id, profile_id, kind, title, body, take_id")
        .eq("id", notification_id).maybeSingle();
      if (!n) return json(404, { error: "not_found" });
      const { data: subs } = await db.from("push_subscriptions").select("id, endpoint, p256dh, auth")
        .eq("profile_id", n.profile_id);
      const body = JSON.stringify(payload(n as Note));
      let sent = 0;
      const gone: number[] = [];
      await Promise.all((subs ?? []).map(async (s) => {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: 3600, urgency: "normal" });
          sent++;
        } catch (e) {
          const status = (e as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) gone.push(s.id);
          else console.error("push failed", status, (e as Error).message);
        }
      }));
      if (gone.length) await db.from("push_subscriptions").delete().in("id", gone);
      if (sent) await db.from("push_subscriptions").update({ last_sent_at: new Date().toISOString() }).eq("profile_id", n.profile_id);
      return json(200, { sent, removed: gone.length });
    }

    if (route === "subscribe" && (req.method === "POST" || req.method === "DELETE")) {
      const did = await privyDid(req);
      if (!did) return json(401, { error: "invalid_privy_token" });
      const { data: profileId, error } = await db.rpc("ensure_account", { p_privy_did: did });
      if (error) throw error;
      const b = await req.json().catch(() => null);
      if (req.method === "DELETE") {
        const endpoint = typeof b?.endpoint === "string" ? b.endpoint : "";
        await db.from("push_subscriptions").delete().eq("endpoint", endpoint).eq("profile_id", profileId);
        return json(200, { removed: true });
      }
      const sub = parseSubscription(b);
      if (!sub) return json(400, { error: "invalid_subscription" });
      const { error: upErr } = await db.from("push_subscriptions").upsert(
        { profile_id: profileId, ...sub, user_agent: req.headers.get("user-agent")?.slice(0, 300) ?? null },
        { onConflict: "endpoint" },
      );
      if (upErr) throw upErr;
      return json(200, { saved: true });
    }

    return json(404, { error: "no_such_route" });
  } catch (e) {
    console.error(e);
    return json(500, { error: "internal" });
  }
});
