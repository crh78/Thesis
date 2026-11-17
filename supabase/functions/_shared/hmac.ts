// Request signing between Thesis services and Supabase functions, the way QuickNode signs Stream
// deliveries: x-qn-nonce, x-qn-timestamp, x-qn-signature = hex HMAC-SHA256(nonce + timestamp + body).
// Used by quicknode-stream (the Stream's security token) and notify (the backend's token).

/**
 * QuickNode's webhook signature: hex HMAC-SHA256 of nonce + timestamp + body with the Stream's
 * security token. Requests older than `maxAgeSecs` are refused, so a captured one can't be replayed.
 */
export async function verifySignature(headers: Headers, body: string, token: string, nowSec = Math.floor(Date.now() / 1000), maxAgeSecs = 300): Promise<boolean> {
  const nonce = headers.get("x-qn-nonce");
  const timestamp = headers.get("x-qn-timestamp");
  const signature = headers.get("x-qn-signature");
  if (!nonce || !timestamp || !signature) return false;
  if (!(Math.abs(nowSec - Number(timestamp)) <= maxAgeSecs)) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(nonce + timestamp + body)));
  const expected = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
  // Constant-time compare.
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}
