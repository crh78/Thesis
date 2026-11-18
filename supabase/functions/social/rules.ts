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
