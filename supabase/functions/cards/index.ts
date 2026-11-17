// Called-it card pictures, uploaded from the app so a shared link can preview as the card.
//
//   POST ?take=<take uuid>   body: the card as a JPEG (≤ 2 MB), header privy-token: <jwt>
//     → 200 { card, image }  card: the picture's id; image: its public URL.
//
// Stored at cards/<take>/<card>.jpg in the public `cards` bucket. The app then shares
// <web>/c/<take>?card=<card>, whose og:image is that picture.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { privyDid } from "../_shared/privy.ts";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BYTES = 2 * 1024 * 1024;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  if (!(await privyDid(req))) return json(401, { error: "unauthorized" });

  const take = new URL(req.url).searchParams.get("take")?.toLowerCase() ?? "";
  if (!UUID_RE.test(take)) return json(400, { error: "invalid_take" });
  const { data: row } = await db.from("takes").select("id").eq("id", take).maybeSingle();
  if (!row) return json(404, { error: "take_not_found" });

  const body = new Uint8Array(await req.arrayBuffer());
  if (body.length === 0 || body.length > MAX_BYTES) return json(413, { error: "bad_size" });
  // JPEG magic number: FF D8 FF.
  if (body[0] !== 0xff || body[1] !== 0xd8 || body[2] !== 0xff) return json(415, { error: "jpeg_only" });

  const card = crypto.randomUUID();
  const path = `${take}/${card}.jpg`;
  const bucket = db.storage.from("cards");
  const { error } = await bucket.upload(path, body, { contentType: "image/jpeg", cacheControl: "31536000" });
  if (error) {
    console.error("card upload failed", error);
    return json(500, { error: "upload_failed" });
  }
  return json(200, { card, image: bucket.getPublicUrl(path).data.publicUrl });
});
