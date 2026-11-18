// The X account a Privy user linked (no env, no network: shared by privy.ts and its tests).

/** The X account among Privy's linked accounts, lowercased. */
export function xUsernameOf(accounts: { type?: string; username?: string }[]): string | null {
  const u = accounts.find((a) => a.type === "twitter_oauth")?.username?.toLowerCase() ?? "";
  return /^[a-z0-9_]{1,15}$/.test(u) ? u : null;
}
