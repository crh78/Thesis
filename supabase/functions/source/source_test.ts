// deno test --config deno.json --allow-env .
// The parsing half of _shared/source.ts and _shared/x.ts (no network, no model).
import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import {
  articleText, checkHost, checkUrl, cleanClaim, decode, fetchPublic, isPublicIp, readCapped, readSource, slugTitle, xPost,
} from "../_shared/source.ts";
import { parseHandle } from "../_shared/x.ts";
import { xUsernameOf } from "../_shared/x_account.ts";

Deno.test("X post links: x.com, twitter.com, mobile, with tracking", () => {
  assertEquals(xPost("https://x.com/KobeissiLetter/status/2121729777891496181"), { username: "KobeissiLetter", id: "2121729777891496181" });
  assertEquals(xPost("https://twitter.com/unusual_whales/status/123?s=20&t=abc"), { username: "unusual_whales", id: "123" });
  assertEquals(xPost("https://mobile.x.com/a_b/statuses/9"), { username: "a_b", id: "9" });
  assertEquals(xPost("https://x.com/KobeissiLetter"), null);
  assertEquals(xPost("https://www.reuters.com/markets/"), null);
});

Deno.test("only public http(s) URLs are read", () => {
  checkUrl("https://www.reuters.com/markets/x");
  checkUrl("http://www.reuters.com:80/markets/x");
  checkUrl("https://www.reuters.com:443/markets/x");
  checkUrl("http://8.8.8.8/");
  for (const bad of [
    "ftp://a.com/x", "http://localhost:54321/", "http://127.0.0.1/", "http://10.0.0.2/", "http://192.168.1.1/",
    "http://169.254.169.254/latest", "http://intranet/", "not a url",
    // Other ports, the CGNAT range, other spellings of loopback, IPv6 literals, a trailing dot.
    "https://www.reuters.com:8443/", "http://example.com:22/", "http://100.64.0.1/", "http://100.127.255.254/",
    "http://2130706433/", "http://0x7f.1/", "http://127.1/", "http://[::1]/", "http://[::ffff:127.0.0.1]/",
    "http://localhost./", "http://app.localhost/", "http://user:pw@example.com/",
  ]) {
    assertThrows(() => checkUrl(bad), Error, "invalid_url", bad);
  }
});

Deno.test("public addresses only", () => {
  for (const ok of ["8.8.8.8", "1.1.1.1", "100.63.255.255", "100.128.0.1", "172.32.0.1", "2606:4700::6810:84e5", "2a00:1450:4001:82b::200e"]) {
    assertEquals(isPublicIp(ok), true, ok);
  }
  for (const bad of [
    "0.0.0.0", "10.1.2.3", "100.64.0.1", "100.100.100.100", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255",
    "192.168.0.1", "192.0.0.1", "198.18.0.1", "224.0.0.1", "255.255.255.255",
    "::", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "fc00::1", "fd12:3456::1",
    "fe80::1", "fe80::1%en0", "ff02::1", "2001:db8::1", "2002:0a00:0001::1", "not an ip", "1.2.3", "1::2::3",
  ]) {
    assertEquals(isPublicIp(bad), false, bad);
  }
});

/** A resolver from a table: names not in it don't resolve. */
const dns = (table: Record<string, string[]>) => (host: string) => Promise.resolve(table[host] ?? []);

/** A fetch that answers from a table of URL → response, and records what it was asked for. */
function fakeFetch(pages: Record<string, () => Response>) {
  const asked: string[] = [];
  const f = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    asked.push(url);
    if (init?.redirect !== "manual") throw new Error("redirects must be followed by hand");
    const page = pages[url];
    return Promise.resolve(page ? page() : new Response("missing", { status: 404 }));
  }) as typeof fetch;
  return { fetch: f, asked };
}

const redirect = (to: string, status = 302) => () => new Response(null, { status, headers: { location: to } });
const page = (html: string) => () => new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });

const PUBLIC = { "news.example.com": ["93.184.216.34"], "cdn.example.com": ["2606:4700::6810:84e5"] };

Deno.test("a host must resolve to public addresses only", async () => {
  await checkHost(new URL("https://news.example.com/"), dns(PUBLIC));
  await checkHost(new URL("http://8.8.8.8/"), dns({})); // a literal needs no lookup
  for (const ips of [[], ["10.0.0.5"], ["100.64.1.1"], ["93.184.216.34", "127.0.0.1"], ["::1"], ["fe80::2"], ["::ffff:192.168.0.1"]]) {
    await assertRejects(() => checkHost(new URL("https://evil.example.com/"), dns({ "evil.example.com": ips })), Error, "invalid_url");
  }
});

Deno.test("redirects: every hop is checked before it's requested", async () => {
  // Public → public: followed, and the last URL is the page's.
  {
    const f = fakeFetch({
      "https://news.example.com/a": redirect("/b", 301),
      "https://news.example.com/b": redirect("https://cdn.example.com/c"),
      "https://cdn.example.com/c": page("<title>ok</title>"),
    });
    const { url, response } = await fetchPublic("https://news.example.com/a", "text/html", { fetch: f.fetch, resolve: dns(PUBLIC) });
    assertEquals(url.toString(), "https://cdn.example.com/c");
    assertEquals(await response.text(), "<title>ok</title>");
    assertEquals(f.asked.length, 3);
  }
  // To a private address, a private name, another port, or another scheme: never requested.
  for (const to of ["http://169.254.169.254/latest/meta-data", "http://inside.example.com/", "https://cdn.example.com:8080/", "file:///etc/passwd", "http://[::1]/"]) {
    const f = fakeFetch({ "https://news.example.com/a": redirect(to) });
    await assertRejects(
      () => fetchPublic("https://news.example.com/a", "text/html", { fetch: f.fetch, resolve: dns({ ...PUBLIC, "inside.example.com": ["10.1.1.1"] }) }),
      Error,
      "invalid_url",
    );
    assertEquals(f.asked, ["https://news.example.com/a"], to);
  }
  // A name that resolves privately isn't requested even first.
  {
    const f = fakeFetch({});
    await assertRejects(() => fetchPublic("https://127.0.0.1.nip.io/", "text/html", { fetch: f.fetch, resolve: dns({ "127.0.0.1.nip.io": ["127.0.0.1"] }) }), Error, "invalid_url");
    assertEquals(f.asked, []);
  }
  // At most 3 redirects.
  {
    const f = fakeFetch({ "https://news.example.com/loop": redirect("/loop") });
    await assertRejects(() => fetchPublic("https://news.example.com/loop", "text/html", { fetch: f.fetch, resolve: dns(PUBLIC) }), Error, "too_many_redirects");
    assertEquals(f.asked.length, 4);
  }
});

Deno.test("the body is cut off while it streams", async () => {
  let pulled = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      pulled++;
      c.enqueue(new TextEncoder().encode("a".repeat(1000)));
      if (pulled === 1000) c.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  const text = await readCapped(new Response(body), 2500);
  assertEquals(text.length, 2500);
  assertEquals(cancelled, true);
  assertEquals(pulled < 10, true);
});

Deno.test("an article is fetched through the guards, and a refused one falls back to the URL", async () => {
  const html = `<html><head><meta property="og:title" content="Copper squeeze"><meta property="og:site_name" content="Example News"></head>
    <body><article><p>Copper jumped to a record as smelters cut output and warehouses ran low on metal again.</p></article></body></html>`;
  const ok = fakeFetch({ "https://news.example.com/copper": redirect("https://news.example.com/copper-squeeze-hits-record"), "https://news.example.com/copper-squeeze-hits-record": page(html) });
  const s = await readSource("https://news.example.com/copper", {}, { fetch: ok.fetch, resolve: dns(PUBLIC) });
  assertEquals(s.title, "Copper squeeze");
  assertEquals(s.label, "Example News");
  assertEquals(s.url, "https://news.example.com/copper-squeeze-hits-record");

  const bad = fakeFetch({ "https://news.example.com/copper-rally-goes-on": redirect("http://10.0.0.1/admin"), "http://10.0.0.1/admin": page(html) });
  const t = await readSource("https://news.example.com/copper-rally-goes-on", {}, { fetch: bad.fetch, resolve: dns(PUBLIC) });
  assertEquals(bad.asked, ["https://news.example.com/copper-rally-goes-on"]);
  assertEquals(t.title, "Copper rally goes on");
  assertEquals(t.text, "");
});

Deno.test("article text: paragraphs in the article, chrome left out", () => {
  const html = `<html><head><script>var x = "<p>not this</p>";</script></head><body>
    <nav><p>Home Markets World Business and a long menu line that should not count at all</p></nav>
    <article><h1>Gold</h1><p>Gold rose to a record on Friday as central banks kept buying &amp; the dollar fell.</p>
    <p>Short.</p><p>Analysts at Goldman see $4,500 by the middle of next year, citing &#8220;relentless&#8221; demand.</p></article>
    <footer><p>Copyright 2026 and other words that are long enough to pass the length filter</p></footer></body></html>`;
  assertEquals(articleText(html), "Gold rose to a record on Friday as central banks kept buying & the dollar fell.\nAnalysts at Goldman see $4,500 by the middle of next year, citing “relentless” demand.");
});

Deno.test("entities decode", () => {
  assertEquals(decode("AT&amp;T &#39;up&#39; &#x2014; &hellip;"), "AT&T 'up' — ...");
});

Deno.test("claims: no long dashes, at most 140 characters, no wrapping quotes", () => {
  assertEquals(cleanClaim("“Gold” — higher"), "“Gold”, higher");
  assertEquals(cleanClaim('"Nvidia beats again"'), "Nvidia beats again");
  const long = cleanClaim("word ".repeat(60));
  assertEquals(long.length <= 140, true);
  assertEquals(long.endsWith("…"), true);
});

Deno.test("X handles from what people type or paste", () => {
  assertEquals(parseHandle("@KobeissiLetter"), "KobeissiLetter");
  assertEquals(parseHandle(" unusual_whales "), "unusual_whales");
  assertEquals(parseHandle("https://x.com/KobeissiLetter?s=21"), "KobeissiLetter");
  assertEquals(parseHandle("https://twitter.com/elonmusk/status/1"), "elonmusk");
  assertEquals(parseHandle("not a handle!"), null);
  assertEquals(parseHandle("waytoolonghandle_123"), null);
});

Deno.test("a headline from the URL when the page can't be read", () => {
  assertEquals(slugTitle(new URL("https://www.reuters.com/markets/us/fed-cuts-rates-again-as-inflation-cools-2026-12-14/")), "Fed cuts rates again as inflation cools");
  assertEquals(slugTitle(new URL("https://apnews.com/article/nvidia-earnings-ai-chips-4f1c2a9b8e7d")), "Nvidia earnings ai chips");
  assertEquals(slugTitle(new URL("https://www.bloomberg.com/markets")), null);
});

Deno.test("the page the phone fetched is read without fetching again", async () => {
  const html = `<html><head><meta property="og:title" content="Gold hits a record"><meta property="og:site_name" content="Reuters">
    <meta property="og:description" content="Central banks keep buying."></head><body><article>
    <p>Gold rose to a record on Friday as central banks kept buying and the dollar slid again.</p></article></body></html>`;
  const s = await readSource("https://www.reuters.com/markets/gold-record-2026-12-14/", { html });
  assertEquals(s.label, "Reuters");
  assertEquals(s.title, "Gold hits a record");
  assertEquals(s.text, "Central banks keep buying.\nGold rose to a record on Friday as central banks kept buying and the dollar slid again.");
});

Deno.test("the X account among Privy's linked accounts", () => {
  assertEquals(xUsernameOf([{ type: "email" }, { type: "twitter_oauth", username: "Jake_Trades" }]), "jake_trades");
  assertEquals(xUsernameOf([{ type: "google_oauth", username: "jake" }]), null);
  assertEquals(xUsernameOf([{ type: "twitter_oauth", username: "not a handle!" }]), null);
});
