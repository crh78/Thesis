// Phoenix on the fork: the onboarding permission that lets the fork register traders.
//
// On mainnet, Phoenix's onboarder key co-signs every new trader (`onboard_trader_delegated`),
// authorized by a permission account Phoenix's risk authority created. That permission is an
// ordinary account, so the fork writes a copy that names a fork-only key instead
// (`forkOnboardingPermission`). Registration then uses the same instructions as mainnet, built by
// Phoenix's API, with the fork's key in place of Phoenix's. Nothing changes on mainnet.
import { PublicKey, type Keypair } from "@solana/web3.js";
import { forkOnboardingPermission, permissionAddress, permissionDelegate, PHOENIX_PROGRAM_ID } from "@thesis/venues/phoenix";
import { PATHS, connection, loadOrCreateKeypair, rpc } from "./lib.ts";

/** Phoenix's mainnet onboarder and the risk authority that granted its permission. */
const PHOENIX_ONBOARDER = new PublicKey("EzkM8YbCkBLaCqX2cdxtMyxfTLpKui3mWQWnhe5w2P4Z");
const PHOENIX_RISK_AUTHORITY = new PublicKey("8wTcJdg4Xw3wnvmBu7Sokn3c2UnnHUhuB5g9sfeCMidR");

export type ForkOnboarder = { onboarder: Keypair; permission: PublicKey };

/**
 * The fork's onboarder key (created under .data/fork on first use) and its permission, written
 * if missing. Idempotent: `fork:up` calls it, and so does anything that registers traders.
 */
export async function ensureForkOnboarder(): Promise<ForkOnboarder & { written: boolean }> {
  const { keypair: onboarder } = loadOrCreateKeypair(PATHS.phoenixOnboarder);
  const conn = connection();
  const ours = permissionAddress(PHOENIX_RISK_AUTHORITY, onboarder.publicKey);
  const existing = await conn.getAccountInfo(ours, "confirmed");
  if (existing?.owner.equals(PHOENIX_PROGRAM_ID) && permissionDelegate(existing.data).equals(onboarder.publicKey)) {
    return { onboarder, permission: ours, written: false };
  }
  // Phoenix's own permission, copied from mainnet on first read.
  const theirs = await conn.getAccountInfo(permissionAddress(PHOENIX_RISK_AUTHORITY, PHOENIX_ONBOARDER), "confirmed");
  if (!theirs?.owner.equals(PHOENIX_PROGRAM_ID)) throw new Error("Phoenix's onboarding permission isn't readable on the fork");
  const { address, data } = forkOnboardingPermission(theirs.data, onboarder.publicKey);
  if (!address.equals(ours)) throw new Error("Phoenix's permission names a different authority than expected");
  await rpc("surfnet_setAccount", [address.toBase58(), { lamports: theirs.lamports, owner: PHOENIX_PROGRAM_ID.toBase58(), data: data.toString("hex") }]);
  return { onboarder, permission: ours, written: true };
}
