"use client";
// Add to home screen and web push. On iPhone, web push works only once Thesis runs from the home
// screen (iOS 16.4+), so the app asks for notifications after it's installed.

/** The VAPID public key (public by design; the private half is the web-push function's secret). */
export const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "BPQXoa7cak3jxlRdFw5nVKdSCVmCpcUxhV53AYGbV0TSIwYKf-7hM4_hnfV1qdYl9Pru6_3bWCxs271NFaRU5c4";

export const isStandalone = () =>
  typeof window !== "undefined" &&
  (window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true);

export const isIOS = () => typeof navigator !== "undefined" && (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));
/** Which browser on an iPhone or iPad: they all add to the home screen, from different places. */
export type IOSBrowser = "safari" | "chrome" | "firefox" | "edge" | "other";
export function iosBrowser(): IOSBrowser {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent;
  if (/CriOS/.test(ua)) return "chrome";
  if (/FxiOS/.test(ua)) return "firefox";
  if (/EdgiOS/.test(ua)) return "edge";
  if (/Safari/.test(ua) && !/(OPiOS|GSA|DuckDuckGo|YaBrowser)/.test(ua)) return "safari";
  return "other";
}
export const isPhone = () => typeof navigator !== "undefined" && (/iPhone|iPod|Android.+Mobile/.test(navigator.userAgent) || (isIOS() && navigator.maxTouchPoints > 1));
export const pushSupported = () => typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  } catch {
    return null;
  }
}

function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = (b64url + "=".repeat((4 - (b64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** This browser's push subscription, if it has one. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration("/");
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/**
 * Asks for permission (if needed), subscribes this browser and saves it for the signed-in person.
 * The permission ask comes first, straight from the tap: Safari only shows it during a user
 * gesture, so the token is fetched after.
 */
export async function enablePush(getToken: () => Promise<string>): Promise<"on" | "denied" | "unsupported"> {
  if (!pushSupported()) return "unsupported";
  const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
  if (permission !== "granted") return "denied";
  const reg = (await navigator.serviceWorker.getRegistration("/")) ?? (await registerServiceWorker());
  if (!reg) return "unsupported";
  await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC_KEY) }));
  const r = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "privy-token": await getToken(), "content-type": "application/json" },
    body: JSON.stringify(sub.toJSON()),
  });
  if (!r.ok) throw new Error("Couldn't turn on notifications. Try again.");
  return "on";
}

/** Stops push on this browser (Settings, and logging out so the next account doesn't get your pushes). */
export async function disablePush(getToken: () => Promise<string>): Promise<void> {
  const sub = await currentSubscription().catch(() => null);
  if (!sub) return;
  const token = await getToken().catch(() => null);
  if (token) await fetch("/api/push/subscribe", {
    method: "DELETE",
    headers: { "privy-token": token, "content-type": "application/json" },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}
