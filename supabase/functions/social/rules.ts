// Posting rules the server decides, whatever the client sends (social POST /takes).

/**
 * Whether a client may post a take live at once, without the chain. Off unless the project sets
 * TAKES_LIVE_WITHOUT_CHAIN=on (a project serving only non-fork builds). Off, every take is created
 * posting, seen by its author only, and only the on-chain buy-in's takeCreated event makes it live
 * (migrations/*_post_after_chain.sql).
 */
export const LIVE_WITHOUT_CHAIN = Deno.env.get("TAKES_LIVE_WITHOUT_CHAIN") === "on";

/** The status a new take starts in: posting, unless live posts are allowed and the client didn't ask to wait. */
export function takeStatus(awaitChain: unknown, liveWithoutChain = LIVE_WITHOUT_CHAIN): "posting" | "live" {
  return liveWithoutChain && awaitChain !== true ? "live" : "posting";
}

/**
 * Whether a new take is inverted: it bets against its basket ("crypto sucks" on BTC, ETH and SOL),
 * so its author's buy-in is an on-chain fade (migrations/*_inverted_takes.sql). true or false; left
 * out (or null), false. Anything else is null: refused, not guessed.
 */
export function takeInverted(v: unknown): boolean | null {
  if (v === undefined || v === null) return false;
  return typeof v === "boolean" ? v : null;
}

/** An inverted take's buy-in fades every leg, so each must be one that can be faded (it has a fade_how). */
export function legsFadeable(legs: { fade_how: string | null }[]): boolean {
  return legs.every((l) => typeof l.fade_how === "string" && l.fade_how.length > 0);
}
