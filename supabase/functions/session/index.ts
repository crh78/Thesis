// session: bridges a Privy login to a Thesis profile.
//
//   GET   → verify the Privy token, find-or-create the user, sync their embedded
//           Solana wallet, return { profile, account, needs_onboarding }.
//   PATCH → same, then apply onboarding fields:
//           { handle?, display_name?, country?, us_state?, avatar? }
//           `avatar` is a built-in face, "face:<name>:<color>", stored in
//           profiles.avatar_url (which the app also reads as asset:/https:).
//           { reset: true } wipes the profile back to "just signed up" (handle,
//           name, avatar, location, onboarded, who they follow). Privy test
//           accounts only, so the debug dev login always goes through onboarding.
//   POST  → upload a profile photo: body is the image (image/jpeg or image/png,
//           ≤ 3 MB). Stored in the public `avatars` bucket; avatar_url = its URL.
//   DELETE { confirm: "delete" } → deletes the account for good: photos, the
//           profile and everything that hangs off it (takes, comments, follows,
//           saves, cash ledger rows: all `on delete cascade`), and the Privy
//           user so the login can't come back to an empty profile. Privy test
//           accounts keep their Privy user (the dev login must keep working);
//           their next sign-in starts over at onboarding.
//
// The app sends its Privy access token as `privy-token: <jwt>` (or
// `Authorization: Bearer <jwt>`). JWT verification at the Supabase gateway is
// off for this function (see config.toml) because the token is Privy's, not Supabase's.
//
// Secrets (supabase secrets set …): PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_VERIFICATION_KEY.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected by the platform.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { importSPKI, jwtVerify } from "npm:jose@5";

const PRIVY_APP_ID = Deno.env.get("PRIVY_APP_ID")!;
const PRIVY_APP_SECRET = Deno.env.get("PRIVY_APP_SECRET")!;
// PEM may be stored on one line with literal "\n" escapes (env files); normalize.
const PRIVY_VERIFICATION_KEY = Deno.env.get("PRIVY_VERIFICATION_KEY")!.replace(/\\n/g, "\n");

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const verificationKey = importSPKI(PRIVY_VERIFICATION_KEY, "ES256");

const HANDLE_RE = /^[a-z0-9_]{3,20}$/;
const CODE2_RE = /^[A-Z]{2}$/;
const FACE_RE = /^face:person-\d{2}:\d{1,2}$/;
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
const PHOTO_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png" };

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function privyDidFrom(req: Request): Promise<string | null> {
  const raw = req.headers.get("privy-token") ??
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!raw) return null;
  try {
    const { payload } = await jwtVerify(raw, await verificationKey, {
      issuer: "privy.io",
      audience: PRIVY_APP_ID,
    });
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

// Privy test accounts (dashboard → Authentication → Advanced): test-XXXX@privy.io,
// or the legacy test@privy.io.
const TEST_ACCOUNT_RE = /^test(-\d+)?@privy\.io$/i;

type PrivyUser = { wallet: string | null; isTestAccount: boolean };

// The access token carries no wallet or email info, so ask Privy for the user:
// their embedded Solana wallet (rather than trusting an address from the
// client) and whether this is a test account.
async function privyUser(did: string): Promise<PrivyUser> {
  const res = await fetch(`https://api.privy.io/v1/users/${encodeURIComponent(did)}`, {
    headers: {
      "privy-app-id": PRIVY_APP_ID,
      authorization: `Basic ${btoa(`${PRIVY_APP_ID}:${PRIVY_APP_SECRET}`)}`,
    },
  });
  if (!res.ok) {
    console.error("privy user lookup failed", res.status, await res.text());
    return { wallet: null, isTestAccount: false };
  }
  const user = await res.json();
  // Primary embedded Solana wallet = lowest wallet_index (HD index 0).
  type LinkedAccount = {
    type: string;
    chain_type?: string;
    wallet_client_type?: string;
    wallet_index?: number;
    address?: string;
  };
  const accounts = (user.linked_accounts ?? []) as LinkedAccount[];
  const isTestAccount = accounts.some((a) => a.type === "email" && TEST_ACCOUNT_RE.test(a.address ?? ""));
  const wallet = accounts
    .filter((a) =>
      a.type === "wallet" && a.chain_type === "solana" && a.wallet_client_type === "privy"
    )
    .sort((a, b) => (a.wallet_index ?? 0) - (b.wallet_index ?? 0))[0];
  return { wallet: wallet?.address ?? null, isTestAccount };
}

async function deleteAccount(req: Request, profileId: string, did: string, isTestAccount: boolean) {
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch { /* checked below */ }
  if (body.confirm !== "delete") return json(400, { error: "confirm_required" });

  const bucket = db.storage.from("avatars");
  const { data: photos } = await bucket.list(profileId);
  if (photos?.length) await bucket.remove(photos.map((f) => `${profileId}/${f.name}`));

  const { error } = await db.from("profiles").delete().eq("id", profileId);
  if (error) {
    console.error("delete profile failed", error);
    return json(500, { error: "internal" });
  }

  if (!isTestAccount) {
    const res = await fetch(`https://auth.privy.io/api/v1/users/${encodeURIComponent(did)}`, {
      method: "DELETE",
      headers: {
        "privy-app-id": PRIVY_APP_ID,
        authorization: `Basic ${btoa(`${PRIVY_APP_ID}:${PRIVY_APP_SECRET}`)}`,
      },
    });
    // The profile is already gone; a failed Privy delete only leaves a login
    // that would start over at onboarding. Log it for cleanup.
    if (!res.ok) console.error("privy user delete failed", res.status, await res.text());
  }
  return json(200, { deleted: true });
}

async function load(profileId: string) {
  const [{ data: profile, error: pErr }, { data: account, error: aErr }] = await Promise.all([
    db.from("profiles").select("*").eq("id", profileId).single(),
    db.from("accounts").select("country, us_state, onboarded_at").eq("profile_id", profileId).single(),
  ]);
  if (pErr || aErr) throw pErr ?? aErr;
  return { profile, account, needs_onboarding: !account.onboarded_at };
}

Deno.serve(async (req) => {
  if (!["GET", "PATCH", "POST", "DELETE"].includes(req.method)) {
    return json(405, { error: "method_not_allowed" });
  }

  const did = await privyDidFrom(req);
  if (!did) return json(401, { error: "invalid_privy_token" });

  const { data: profileId, error: ensureErr } = await db.rpc("ensure_account", { p_privy_did: did });
  if (ensureErr) {
    console.error(ensureErr);
    return json(500, { error: "internal" });
  }

  // Keep the wallet address in sync (it's created client-side right after first login).
  const privy = await privyUser(did);

  if (req.method === "DELETE") return await deleteAccount(req, String(profileId), did, privy.isTestAccount);
  const address = privy.wallet;
  if (address) {
    await db.from("profiles").update({ solana_address: address })
      .eq("id", profileId).is("solana_address", null);
  }

  if (req.method === "POST") {
    const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const ext = PHOTO_TYPES[type];
    if (!ext) return json(415, { error: "unsupported_image_type" });
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.length === 0) return json(400, { error: "empty_image" });
    if (bytes.length > MAX_PHOTO_BYTES) return json(413, { error: "image_too_large" });

    const folder = String(profileId);
    const path = `${folder}/${Date.now()}.${ext}`;
    const bucket = db.storage.from("avatars");
    const { error: upErr } = await bucket.upload(path, bytes, { contentType: type, upsert: false });
    if (upErr) {
      console.error("avatar upload failed", upErr);
      return json(500, { error: "internal" });
    }
    const { data: pub } = bucket.getPublicUrl(path);
    const { error: setErr } = await db.from("profiles")
      .update({ avatar_url: pub.publicUrl })
      .eq("id", profileId);
    if (setErr) {
      console.error(setErr);
      return json(500, { error: "internal" });
    }
    // Keep only the newest photo.
    const { data: old } = await bucket.list(folder);
    const stale = (old ?? []).map((f) => `${folder}/${f.name}`).filter((p) => p !== path);
    if (stale.length) await bucket.remove(stale);
  }

  if (req.method === "PATCH") {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json(400, { error: "invalid_json" });
    }

    if (body.reset === true) {
      if (!privy.isTestAccount) return json(403, { error: "reset_not_allowed" });
      const { error: pErr } = await db.from("profiles")
        .update({ handle: null, display_name: null, avatar_url: null, bio: null, show_following: true, show_followers: true })
        .eq("id", profileId);
      const { error: aErr } = await db.from("accounts")
        .update({ country: null, us_state: null, onboarded_at: null }).eq("profile_id", profileId);
      const { error: fErr } = await db.from("follows").delete().eq("follower_id", profileId);
      if (pErr || aErr || fErr) {
        console.error(pErr ?? aErr ?? fErr);
        return json(500, { error: "internal" });
      }
      return json(200, await load(profileId));
    }

    const profileUpdate: Record<string, unknown> = {};
    const accountUpdate: Record<string, unknown> = {};

    if (body.handle !== undefined) {
      const handle = String(body.handle).trim().toLowerCase().replace(/^@/, "");
      if (!HANDLE_RE.test(handle)) return json(400, { error: "invalid_handle" });
      profileUpdate.handle = handle;
    }
    if (body.display_name !== undefined) {
      const name = String(body.display_name).trim();
      if (name.length === 0 || name.length > 50) return json(400, { error: "invalid_display_name" });
      profileUpdate.display_name = name;
    }
    if (body.avatar !== undefined) {
      const avatar = String(body.avatar);
      if (!FACE_RE.test(avatar)) return json(400, { error: "invalid_avatar" });
      profileUpdate.avatar_url = avatar;
    }
    if (body.country !== undefined) {
      const country = String(body.country).toUpperCase();
      if (!CODE2_RE.test(country)) return json(400, { error: "invalid_country" });
      accountUpdate.country = country;
      if (country !== "US") accountUpdate.us_state = null;
    }
    if (body.us_state !== undefined && body.us_state !== null) {
      const state = String(body.us_state).toUpperCase();
      if (!CODE2_RE.test(state)) return json(400, { error: "invalid_us_state" });
      accountUpdate.us_state = state;
    }

    if (Object.keys(profileUpdate).length) {
      const { error } = await db.from("profiles").update(profileUpdate).eq("id", profileId);
      if (error?.code === "23505") return json(409, { error: "handle_taken" });
      if (error) {
        console.error(error);
        return json(500, { error: "internal" });
      }
    }
    if (Object.keys(accountUpdate).length) {
      const { error } = await db.from("accounts").update(accountUpdate).eq("profile_id", profileId);
      if (error?.code === "23514") return json(400, { error: "us_state_requires_us" });
      if (error) {
        console.error(error);
        return json(500, { error: "internal" });
      }
    }

    // Onboarded once the user has a handle and a country (plus a state if US).
    const current = await load(profileId);
    const a = current.account;
    const done = current.profile.handle && a.country && (a.country !== "US" || a.us_state);
    if (done && !a.onboarded_at) {
      await db.from("accounts").update({ onboarded_at: new Date().toISOString() })
        .eq("profile_id", profileId);
    }
  }

  try {
    return json(200, await load(profileId));
  } catch (e) {
    console.error(e);
    return json(500, { error: "internal" });
  }
});
