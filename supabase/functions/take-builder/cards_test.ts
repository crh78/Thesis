// DENO_NO_PACKAGE_JSON=1 deno test --node-modules-dir=none supabase/functions/take-builder/cards_test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { capCards, cardAbout, cardSecurity, isCardTake, MAX_CARD_WEIGHT, searchCards, searchWords } from "./cards.ts";

// A browse row recorded from api.collectorcrypt.com/marketplace?search=charizard, trimmed.
const row = {
  id: "2026052346C136258",
  itemName: "2024 #003 Radiant Charizard PSA 10 Japanese S11 Lost Abyss",
  category: "Pokemon",
  set: "Lost Abyss",
  year: 2024,
  grade: "GEM MT 10",
  gradingCompany: "PSA",
  insuredValue: "52",
  nftAddress: "zmyePFzwriGrybv9WWYH3uqPcP9GTS4FE98mi3BTqoZ",
  nftStatus: "Valid",
  images: { frontS: "https://d1xpxki1g4htqu.cloudfront.net/abc" },
  listing: { currency: "USDC", price: 66.75 },
};

Deno.test("a CC row becomes a card catalog row priced at its insured value, not its list price", () => {
  const s = cardSecurity(row)!;
  assertEquals(s.id, "card:2026052346C136258");
  assertEquals([s.kind, s.symbol, s.venue, s.liquidity, s.can_short, s.underlying], ["card", "Pokemon", "Collector Crypt", "tradeable", false, null]);
  assertEquals(s.data.insuredValueUsd, 52);
  assertEquals(s.data.grade, "PSA GEM MT 10");
  assertEquals(s.data.image, "https://d1xpxki1g4htqu.cloudfront.net/abc");
  assertEquals(s.description, "A PSA GEM MT 10 Pokemon collectible on Collector Crypt, insured at $52.");
  assertEquals(cardAbout(s), "Pokemon, worth $52");
});

Deno.test("cards with no insured value, or no longer live, can't be picked", () => {
  assertEquals(cardSecurity({ ...row, insuredValue: "0" }), null);
  assertEquals(cardSecurity({ ...row, insuredValue: null }), null);
  assertEquals(cardSecurity({ ...row, nftStatus: "Burned" }), null);
  assertEquals(cardSecurity({ ...row, burnedForBridge: true }), null);
  assertEquals(cardSecurity({ ...row, deletedAt: "2026-12-01T00:00:00Z" }), null);
  assertEquals(cardSecurity({ insuredValue: "5" }), null);
  // An unlisted card is fine: listings don't matter.
  assertEquals(cardSecurity({ ...row, listing: null })?.data.insuredValueUsd, 52);
});

Deno.test("search: one live request with the query, priceable cards only, deduplicated", async () => {
  const urls: string[] = [];
  const fake = (async (url: string, init?: RequestInit) => {
    urls.push(url);
    assertEquals(new Headers(init?.headers).get("user-agent"), "thesis-take-builder/1.0");
    return new Response(JSON.stringify({ filterNFtCard: [row, row, { ...row, id: "X2", insuredValue: "0" }, { ...row, id: "X3" }] }));
  }) as typeof fetch;
  const cards = await searchCards("Charizard PSA 10", 8, fake);
  assertEquals(cards.map((c) => c.id), ["card:2026052346C136258", "card:X3"]);
  assertEquals(new URL(urls[0]).searchParams.get("search"), "Charizard PSA 10");
  assertEquals(new URL(urls[0]).origin, "https://api.collectorcrypt.com");
});

Deno.test("search: a failure or an empty query gives no cards, never an error", async () => {
  const down = (async () => new Response("bad gateway", { status: 502 })) as unknown as typeof fetch;
  assertEquals(await searchCards("Charizard", 8, down), []);
  const throws = (async () => { throw new Error("timeout"); }) as unknown as typeof fetch;
  assertEquals(await searchCards("Charizard", 8, throws), []);
  assertEquals(await searchCards("   ", 8, throws), []);
});

const p = (kind: string, weight: number, name = kind) => ({ s: { kind }, weight, name });

Deno.test("one card at most, kept at or under 20%, never alone", () => {
  // Under the cap: untouched shares, whole percents adding up to 100.
  assertEquals(capCards([p("stock", 50), p("stock", 35), p("card", 15)]).map((x) => x.weight), [50, 35, 15]);
  // Over the cap: the card is cut to 20 and the others share 80 in proportion.
  const over = capCards([p("stock", 30), p("card", 40), p("etf", 30)]);
  assertEquals(over.map((x) => x.weight), [40, MAX_CARD_WEIGHT, 40]);
  // A second card is dropped (the first one stays).
  assertEquals(capCards([p("card", 10, "a"), p("stock", 80), p("card", 10, "b")]).map((x) => x.name), ["a", "stock"]);
  // A card alone isn't a basket.
  assertEquals(capCards([p("card", 100)]), []);
  // No card: nothing changes.
  const plain = [p("stock", 60), p("etf", 40)];
  assertEquals(capCards(plain), plain);
});

Deno.test("rounding can't lift the card past 20%", () => {
  // 19.9% exact: plain rounding of the others (26.36, 26.36, 27.38 → 26, 26, 27) would leave the card 21.
  for (const ws of [[26.36, 26.36, 27.38, 19.9], [1, 1, 1, 0.8], [33.3, 33.3, 13.4, 20]]) {
    const out = capCards(ws.map((w, i) => p(i === ws.length - 1 ? "card" : "stock", w)));
    const card = out.find((x) => x.s.kind === "card")!;
    assertEquals(out.reduce((a, x) => a + x.weight, 0), 100);
    assertEquals(card.weight <= MAX_CARD_WEIGHT, true, JSON.stringify(out.map((x) => x.weight)));
    assertEquals(out.every((x) => Number.isInteger(x.weight)), true);
  }
});

import { applyHouseRules, MAX_PERP_WEIGHT } from "./rules.ts";

Deno.test("with the house rules (rules.ts): the perp cap's excess never lifts the card past 20%", () => {
  type P = { s: { kind: string }; key: string; weight: number; leverage: number };
  const house = (xs: P[]) => applyHouseRules(xs, (p) => ({ kind: p.s.kind, key: p.key, weight: p.weight, leverage: p.leverage }), (p, weight, leverage) => ({ ...p, weight, leverage }));
  // The same loop as finalize() in index.ts.
  const finalize = (ps: P[]) => {
    let out = capCards(house(ps));
    for (let r = 0; r < 4 && out.length > 1 && out.some((p) => p.s.kind === "perp" && p.weight > MAX_PERP_WEIGHT); r++) out = capCards(house(out));
    return out;
  };
  const out = finalize([
    { s: { kind: "perp" }, key: "NVDA-PERP", weight: 50, leverage: 3 },
    { s: { kind: "card" }, key: "card", weight: 20, leverage: 1 },
    { s: { kind: "stock" }, key: "AMD", weight: 30, leverage: 1 },
  ]);
  const w = Object.fromEntries(out.map((p) => [p.s.kind, p.weight]));
  assertEquals(out.reduce((a, p) => a + p.weight, 0), 100);
  assertEquals(w.card <= MAX_CARD_WEIGHT && w.perp <= MAX_PERP_WEIGHT, true, JSON.stringify(w));
});

Deno.test("search words: no accents, no filler (CC's search wants every word in the title)", () => {
  assertEquals(searchWords("graded Pokémon cards"), ["Pokemon"]);
  assertEquals(searchWords("vintage Charizard"), ["Charizard"]);
  assertEquals(searchWords("Michael Jordan rookie card"), ["Michael", "Jordan", "rookie"]);
  assertEquals(searchWords("Charizard PSA 10"), ["Charizard", "PSA", "10"]);
  assertEquals(searchWords("cards"), ["cards"], "all filler: keep what was asked");
  assertEquals(searchWords("Monkey D. Luffy!"), ["Monkey", "D.", "Luffy"]);
});

Deno.test("search: nothing found drops the last word and tries again; a failure stops there", async () => {
  const asked: string[] = [];
  const answers: Record<string, unknown[]> = { "Michael Jordan": [row] };
  const fake = (async (url: string) => {
    const q = new URL(url).searchParams.get("search")!;
    asked.push(q);
    return new Response(JSON.stringify({ filterNFtCard: answers[q] ?? [] }));
  }) as typeof fetch;
  const cards = await searchCards("Michael Jordan rookie card", 8, fake);
  assertEquals(asked, ["Michael Jordan rookie", "Michael Jordan"]);
  assertEquals(cards.length, 1);

  let calls = 0;
  const down = (async () => (calls++, new Response("busy", { status: 429 }))) as unknown as typeof fetch;
  assertEquals(await searchCards("Charizard PSA 10", 8, down), []);
  assertEquals(calls, 1, "a failed request isn't retried with fewer words");

  const none = (async () => new Response(JSON.stringify({ filterNFtCard: [] }))) as unknown as typeof fetch;
  const tried: string[] = [];
  await searchCards("a b c d e", 8, (async (u: string) => (tried.push(new URL(u).searchParams.get("search")!), none(u))) as typeof fetch);
  assertEquals(tried.length, 3, "at most three requests");
});

Deno.test("a take about cards: the basket may be all cards, several of them, any weight", () => {
  const all = [p("card", 60, "a"), p("card", 40, "b")];
  assertEquals(capCards(all, true), all);
  assertEquals(capCards([p("card", 100)], true).map((x) => x.weight), [100]);
  // Mixed with stocks: no cut either.
  assertEquals(capCards([p("stock", 30), p("card", 70)], true).map((x) => x.weight), [30, 70]);
  // Any other take keeps the old rule.
  assertEquals(capCards([p("card", 100)], false), []);
});

Deno.test("which takes are about cards", () => {
  for (const t of [
    "Graded Pokémon cards keep ripping",
    "Charizard PSA 10s double by spring",
    "Vintage sports rookie cards are undervalued",
    "One Piece TCG is the next Pokemon",
    "Collectibles beat stocks this year",
    "Sealed product booster boxes go parabolic",
  ]) assertEquals(isCardTake(t), true, t);
  for (const t of [
    "Nvidia rips higher into earnings",
    "Credit card spending slows into the holidays",
    "Graphics card demand keeps AMD hot",
    "Gift card sales boom this Christmas",
    "The Fed cuts in December",
  ]) assertEquals(isCardTake(t), false, t);
});
