// The X account a Privy user linked (no env, no network: shared by privy.ts and its tests).

/** The X account among Privy's linked accounts, lowercased. */
export function xUsernameOf(accounts: { type?: string; username?: string }[]): string | null {
  const u = accounts.find((a) => a.type === "twitter_oauth")?.username?.toLowerCase() ?? "";
  return /^[a-z0-9_]{1,15}$/.test(u) ? u : null;
}

/**
 * Whether someone may post a draft the X bot made: a draft made for an X account (`forX`) only by
 * the person whose login links that account (`x`, from Privy). Drafts with no `forX` (iMessage)
 * are open to anyone with the link.
 */
export function mayPostDraft(forX: string | null | undefined, x: string | null): boolean {
  if (!forX) return true;
  return x !== null && x === forX.toLowerCase();
}
