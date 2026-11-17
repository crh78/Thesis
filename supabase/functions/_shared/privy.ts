// Verifies a Privy access token and returns the user's Privy DID.
//
// The app sends it as `privy-token: <jwt>` (or `Authorization: Bearer <jwt>`).
// Secrets: PRIVY_APP_ID, PRIVY_VERIFICATION_KEY (PEM, may be stored with
// literal "\n" escapes).

import { importSPKI, jwtVerify } from "npm:jose@5";

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
