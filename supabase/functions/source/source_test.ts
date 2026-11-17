// deno test --config deno.json --allow-env .
// The parsing half of _shared/source.ts and _shared/x.ts (no network, no model).
import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { articleText, checkUrl, cleanClaim, decode, readSource, slugTitle, xPost } from "../_shared/source.ts";
import { parseHandle } from "../_shared/x.ts";

Deno.test("X post links: x.com, twitter.com, mobile, with tracking", () => {
  assertEquals(xPost("https://x.com/KobeissiLetter/status/2121729777891496181"), { username: "KobeissiLetter", id: "2121729777891496181" });
  assertEquals(xPost("https://twitter.com/unusual_whales/status/123?s=20&t=abc"), { username: "unusual_whales", id: "123" });
  assertEquals(xPost("https://mobile.x.com/a_b/statuses/9"), { username: "a_b", id: "9" });
  assertEquals(xPost("https://x.com/KobeissiLetter"), null);
  assertEquals(xPost("https://www.reuters.com/markets/"), null);
});

Deno.test("only public http(s) URLs are read", () => {
  checkUrl("https://www.reuters.com/markets/x");
  for (const bad of ["ftp://a.com/x", "http://localhost:54321/", "http://127.0.0.1/", "http://10.0.0.2/", "http://192.168.1.1/", "http://169.254.169.254/latest", "http://intranet/", "not a url"]) {
    assertThrows(() => checkUrl(bad), Error, "invalid_url");
  }
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
