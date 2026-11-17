// Pure helpers for functions/web-push (tested in web_push_test.ts without secrets).

export type Note = { id: number; kind: string; title: string; body: string; take_id: string | null };

/**
 * What the service worker shows (apps/www/public/sw.js): the title, the body, and where a tap goes,
 * as a path on the app's own origin, so the same push works on thesis-www.vercel.app and yourthesis.xyz.
 */
export function payload(n: Note) {
  const url = n.kind === "x_call" ? "/x" : n.take_id ? `/t/${n.take_id}` : "/";
  return { title: n.title, body: n.body, url, tag: `${n.kind}-${n.take_id ?? n.id}` };
}

/** Compares two secrets in time that doesn't depend on where they differ. */
export function sameSecret(given: string | null, expected: string): boolean {
  const a = new TextEncoder().encode(given ?? "");
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i] ?? 0) ^ b[i];
  return diff === 0;
}

/** A push subscription from the browser, checked before it's stored. */
export function parseSubscription(b: unknown): { endpoint: string; p256dh: string; auth: string } | null {
  if (!b || typeof b !== "object") return null;
  const o = b as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const endpoint = typeof o.endpoint === "string" ? o.endpoint : "";
  const p256dh = typeof o.keys?.p256dh === "string" ? o.keys.p256dh : "";
  const auth = typeof o.keys?.auth === "string" ? o.keys.auth : "";
  if (!/^https:\/\/[^\s]{8,2000}$/.test(endpoint)) return null;
  if (!/^[A-Za-z0-9_-]{40,200}$/.test(p256dh) || !/^[A-Za-z0-9_-]{8,100}$/.test(auth)) return null;
  return { endpoint, p256dh, auth };
}
