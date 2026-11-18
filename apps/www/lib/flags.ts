// Switches for things that wait on someone else.

/**
 * Sign in with X, and connecting X to an account (the one-time prompt, Settings, Me's menu). Off
 * until X login is turned on in the Privy dashboard; turn it on with NEXT_PUBLIC_X_LOGIN=on in
 * Vercel once it is. Until then: Google and email.
 */
export const X_LOGIN = process.env.NEXT_PUBLIC_X_LOGIN === "on";

/**
 * The X bot's handle, without the "@" (apps/x). Whether it's free isn't checked yet, so it can
 * move: NEXT_PUBLIC_X_BOT_HANDLE changes it in one place for every screen that names it.
 */
export const X_BOT = (process.env.NEXT_PUBLIC_X_BOT_HANDLE || "yourthesisxyz").replace(/^@/, "");
