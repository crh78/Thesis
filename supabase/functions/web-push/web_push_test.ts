import { assertEquals } from "jsr:@std/assert@1";
import { parseSubscription, payload, sameSecret } from "./push.ts";

Deno.test("a take's notification opens the take", () => {
  const p = payload({ id: 7, kind: "comment", title: "Dev commented", body: "Nice call", take_id: "abc" });
  assertEquals(p, { title: "Dev commented", body: "Nice call", url: "/t/abc", tag: "comment-abc" });
});

Deno.test("an X call opens Copy from X; one with no take opens Home", () => {
  assertEquals(payload({ id: 1, kind: "x_call", title: "t", body: "", take_id: null }).url, "/x");
  assertEquals(payload({ id: 2, kind: "badge", title: "t", body: "", take_id: null }).url, "/");
});

Deno.test("subscriptions are checked before they're stored", () => {
  const keys = { p256dh: "B".repeat(87), auth: "a".repeat(22) };
  assertEquals(parseSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/xyz123", keys })?.auth, "a".repeat(22));
  assertEquals(parseSubscription({ endpoint: "http://insecure.example/push", keys }), null);
  assertEquals(parseSubscription({ endpoint: "https://web.push.apple.com/abc", keys: { p256dh: "short", auth: "x" } }), null);
  assertEquals(parseSubscription(null), null);
});

Deno.test("the send secret is compared whole", () => {
  assertEquals(sameSecret("abc123abc123abc1", "abc123abc123abc1"), true);
  assertEquals(sameSecret("abc123abc123abc2", "abc123abc123abc1"), false);
  assertEquals(sameSecret("abc", "abc123abc123abc1"), false);
  assertEquals(sameSecret(null, "abc123abc123abc1"), false);
});

