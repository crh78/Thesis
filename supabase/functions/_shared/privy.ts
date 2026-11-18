// Verifies a Privy access token and returns the user's Privy DID.
//
// The app sends it as `privy-token: <jwt>` (or `Authorization: Bearer <jwt>`).
// Secrets: PRIVY_APP_ID, PRIVY_VERIFICATION_KEY (PEM, may be stored with
// literal "\n" escapes).

import { importSPKI, jwtVerify } from "npm:jose@5";
import { xUsernameOf } from "./x_account.ts";

const PRIVY_APP_ID = Deno.env.get("PRIVY_APP_ID")!;
const verificationKey = importSPKI(
  Deno.env.get("PRIVY_VERIFICATION_KEY")!.replace(/\\n/g, "\n"),
  "ES256",
);

export async function privyDid(req: Request): Promise<string | null> {
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

/**
 * The X username linked to this Privy user, lowercased, or null (no X linked, or Privy is down).
 * Read from Privy itself (PRIVY_APP_SECRET), never from the client.
 */
export async function privyXUsername(did: string): Promise<string | null> {
  const secret = Deno.env.get("PRIVY_APP_SECRET");
  if (!secret) return null;
  const res = await fetch(`https://api.privy.io/v1/users/${encodeURIComponent(did)}`, {
    headers: { "privy-app-id": PRIVY_APP_ID, authorization: `Basic ${btoa(`${PRIVY_APP_ID}:${secret}`)}` },
    signal: AbortSignal.timeout(8_000),
  }).catch(() => null);
  if (!res?.ok) return null;
  const user = await res.json() as { linked_accounts?: { type?: string; username?: string }[] };
  return xUsernameOf(user.linked_accounts ?? []);
}

