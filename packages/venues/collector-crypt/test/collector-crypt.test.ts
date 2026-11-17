import assert from "node:assert/strict";
import { test } from "node:test";
import { CC_API, type CardRecord, CollectorCryptClient, CollectorCryptError, cardIdHex, cardPrice, cardUnpriceable, parseCard, retryAfterMs } from "../src/index.ts";

// Shapes recorded from api.collectorcrypt.com, trimmed.
const browseRow = {
  id: "2026033156C116510",
  itemName: "2023 #147 Dratini Master Ball Reverse Holo CGC 10 Pristine Pokemon Card 151 - sv2a - Japanese",
  category: "Pokemon",
  set: "Pokémon Card 151 - sv2a - Japanese",
  year: 2023,
  grade: "PRISTINE 10",
  gradingCompany: "CGC",
  insuredValue: "70",
  nftAddress: "AytXXfg1qiVXnjfxMg4vPt2C3XNC2EvTkB6wyzS5Bmv3",
  nftStandard: "pnft",
  nftStatus: "Valid",
  status: "Transferred",
  frontImage: "https://arweave.net/p-yTq3024l6juXeceZegi8i705kIAmV8KALQtUlTXEg",
  images: { frontS: "https://d1xpxki1g4htqu.cloudfront.net/gVYcBTIS-cVG40GM-rDdY0AOOQAP4oeosqwJwWO7vpA" },
  listing: { currency: "USDC", price: 150, marketplace: "CC" },
};
const singleCard = {
  ...browseRow,
  listing: undefined,
  listedPriceUsd: "150",
  metadataUpdatedAt: "2026-12-13T09:49:39.160Z",
  deletedAt: null,
  getBuybackOffer: false,
};
const unlistedRow = { ...browseRow, id: "2026120111A000001", insuredValue: "30", listing: null };

test("parses a browse row: insured value, not the list price, is the card's value", () => {
  const c = parseCard(browseRow)!;
  assert.equal(c.id, "2026033156C116510");
  assert.equal(c.insuredValueUsd, 70);
  assert.equal(c.listedPriceUsd, 150);
  assert.deepEqual([c.category, c.grade, c.gradingCompany, c.nftStandard, c.year], ["Pokemon", "PRISTINE 10", "CGC", "pnft", 2023]);
  assert.equal(c.image, browseRow.images.frontS);
  assert.equal(c.metadataUpdatedAt, null, "browse rows don't say when the metadata changed");
  assert.equal(cardPrice(c), 70);
});

test("parses a single card, with when its metadata changed", () => {
  const c = parseCard(singleCard)!;
  assert.equal(c.metadataUpdatedAt, Date.parse("2026-12-13T09:49:39.160Z"));
  assert.equal(c.listedPriceUsd, 150);
  assert.equal(c.removed, false);
});

test("an unlisted card is priced the same way: listings don't matter", () => {
  const c = parseCard(unlistedRow)!;
  assert.equal(c.listedPriceUsd, null);
  assert.equal(cardPrice(c), 30);
});

test("no id, no card; odd values read as missing", () => {
  assert.equal(parseCard({}), null);
  assert.equal(parseCard(null), null);
  const c = parseCard({ id: "X1", insuredValue: "abc", year: "n/a", listing: { currency: "SOL", price: 2 } })!;
  assert.deepEqual([c.insuredValueUsd, c.year, c.listedPriceUsd, c.name], [null, null, null, "X1"]);
});

test("a card with no insured value, or no longer a live token, can't be priced", () => {
  const base = parseCard(browseRow)!;
  const cases: [Partial<CardRecord>, RegExp][] = [
    [{ insuredValueUsd: null }, /no insured value/],
    [{ removed: true }, /no longer on Collector Crypt/],
    [{ nftStatus: "Burned" }, /isn't a live token \(Burned\)/],
  ];
  for (const [patch, why] of cases) {
    const c = { ...base, ...patch };
    assert.match(cardUnpriceable(c)!, why);
    assert.equal(cardPrice(c), null);
  }
  assert.equal(parseCard({ ...browseRow, insuredValue: "0" })!.insuredValueUsd, null);
  assert.equal(parseCard({ ...browseRow, burnedForBridge: true })!.removed, true);
  assert.equal(parseCard({ ...browseRow, deletedAt: "2026-12-01T00:00:00Z" })!.removed, true);
});

test("card leg ids: stable sha256 under their own prefix, apart from Gemini's", () => {
  const id = cardIdHex("2026033156C116510");
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.equal(id, cardIdHex("2026033156C116510"));
  assert.notEqual(id, cardIdHex("2026033156C116511"));
  // Pinned so a change to the prefix (which would orphan legs already on-chain) fails here.
  assert.equal(id, "7080404935431854b61595875d668923d667ad52c2d740fb978e58870cd3ae5f");
  assert.throws(() => cardIdHex(" "), /empty/);
});

type Call = { url: string; headers: Record<string, string> };
function fakeFetch(responses: { status: number; body: unknown }[], calls: Call[]): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const r = responses.shift();
    if (!r) throw new Error(`unexpected request ${url}`);
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return new Response(text, { status: r.status });
  }) as unknown as typeof fetch;
}

function clock() {
  let t = 1_000_000;
  const waits: number[] = [];
  return { now: () => t, sleep: async (ms: number) => void (waits.push(ms), (t += ms)), waits };
}

test("client: one card, a User-Agent on every request, the key only as a Bearer header", async () => {
  const calls: Call[] = [];
  const c = new CollectorCryptClient({ fetchFn: fakeFetch([{ status: 200, body: singleCard }, { status: 404, body: { message: "not found" } }], calls), apiKey: "ccsk_test", ...clock() });
  const card = await c.card("2026033156C116510");
  assert.equal(card?.insuredValueUsd, 70);
  assert.equal(calls[0].url, `${CC_API}/cards/publicNft/2026033156C116510`);
  assert.ok(calls[0].headers["user-agent"]);
  assert.equal(calls[0].headers.authorization, "Bearer ccsk_test");
  assert.equal(await c.card("missing"), null, "a 404 is an unknown card");
});

test("client: pages every card (listed or not) until the cursor runs out", async () => {
  const calls: Call[] = [];
  const pages = [
    { status: 200, body: { findTotal: 3, filterNFtCard: [browseRow, unlistedRow], nextCursor: "abc=" } },
    { status: 200, body: { findTotal: 3, filterNFtCard: [{ ...browseRow, id: "C3" }], nextCursor: null } },
  ];
  const c = new CollectorCryptClient({ fetchFn: fakeFetch(pages, calls), ...clock() });
  const seen: string[] = [];
  for await (const batch of c.allCards()) seen.push(...batch.map((x) => x.id));
  assert.deepEqual(seen, ["2026033156C116510", "2026120111A000001", "C3"]);
  assert.equal(calls[0].url, `${CC_API}/marketplace?step=200`);
  assert.equal(calls[1].url, `${CC_API}/marketplace?step=200&cursor=abc%3D`);
  assert.ok(!calls[0].url.includes("listPriceMin"), "unlisted cards are included");
});

test("client: listedOnly asks for listed cards; maxPages stops early", async () => {
  const calls: Call[] = [];
  const c = new CollectorCryptClient({ fetchFn: fakeFetch([{ status: 200, body: { filterNFtCard: [browseRow], nextCursor: "n" } }], calls), ...clock() });
  const batches = [];
  for await (const b of c.allCards({ listedOnly: true, maxPages: 1 })) batches.push(b);
  assert.equal(batches.length, 1);
  assert.match(calls[0].url, /listPriceMin=0\.000001/);
});

test("client: keeps a 250 ms gap between requests, even when called concurrently", async () => {
  const calls: Call[] = [];
  const k = clock();
  const c = new CollectorCryptClient({ fetchFn: fakeFetch([0, 1, 2].map(() => ({ status: 200, body: singleCard })), calls), ...k });
  await Promise.all([c.card("a"), c.card("b"), c.card("c")]);
  assert.equal(calls.length, 3);
  assert.deepEqual(k.waits, [250, 250]);
});

test("client: waits out a 429 (retryAfter in the body), retries a 5xx, then gives up", async () => {
  const calls: Call[] = [];
  const k = clock();
  const c = new CollectorCryptClient({
    fetchFn: fakeFetch([{ status: 429, body: { retryAfter: 7 } }, { status: 502, body: "bad gateway" }, { status: 200, body: singleCard }], calls),
    ...k,
  });
  assert.equal((await c.card("a"))?.id, "2026033156C116510");
  assert.ok(k.waits.includes(7000), "waited the 429's retryAfter");
  assert.ok(k.waits.includes(2000), "backed off after the 502");

  const failing = new CollectorCryptClient({ fetchFn: fakeFetch([0, 1].map(() => ({ status: 500, body: "boom" })), []), retries: 1, ...clock() });
  await assert.rejects(failing.card("a"), (e: unknown) => e instanceof CollectorCryptError && e.status === 500);
});

test("retryAfter: read as seconds, kept between 1 and 60", () => {
  assert.equal(retryAfterMs('{"retryAfter":3}'), 3000);
  assert.equal(retryAfterMs('{"retryAfter":600}'), 60_000);
  assert.equal(retryAfterMs("not json"), 5000);
  assert.equal(retryAfterMs('{"retryAfter":0}'), 1000);
});
