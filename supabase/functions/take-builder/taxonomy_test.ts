// security-tags.json is the source of truth for each security's industry and tags (one line per
// security; edit it by hand when new ones are indexed). This keeps it inside the ontology.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { EVENT_LINKS, eventLinkOf, INDUSTRIES, leagueOf, SECTORS, TAGS } from "../_shared/taxonomy.ts";
import TAGGED from "./security-tags.json" with { type: "json" };

type Tagged = { id: string; symbol: string; sector: string; industry: string; tags: string[] };

Deno.test("every tagged security has one known industry, its sector, and 1-6 known tags", () => {
  const seen = new Set<string>();
  for (const t of TAGGED as Tagged[]) {
    assert(!seen.has(t.id), `${t.symbol}: tagged twice`);
    seen.add(t.id);
    assert(INDUSTRIES[t.industry], `${t.symbol}: unknown industry ${t.industry}`);
    assertEquals(t.sector, INDUSTRIES[t.industry].sector, `${t.symbol}: sector doesn't match its industry`);
    assert(t.tags.length >= 1 && t.tags.length <= 6, `${t.symbol}: ${t.tags.length} tags`);
    for (const tag of t.tags) assert(tag in TAGS, `${t.symbol}: unknown tag ${tag}`);
  }
  for (const i of Object.values(INDUSTRIES)) assert((SECTORS as readonly string[]).includes(i.sector), `unknown sector ${i.sector}`);
});

Deno.test("event links use known industries and tags, and survive a date rolling over", () => {
  for (const l of EVENT_LINKS) {
    for (const i of l.industries) assert(INDUSTRIES[i], `${l.match}: unknown industry ${i}`);
    for (const t of l.tags) assert(t in TAGS, `${l.match}: unknown tag ${t}`);
  }
  assertEquals(eventLinkOf("BTC price on December 31")?.assets.includes("BTC"), true);
  assertEquals(eventLinkOf("Tesla Optimus released this year?")?.assets, ["TSLA"]);
  assertEquals(eventLinkOf("Arizona vs Kansas City"), null);
});

Deno.test("sports tickers map to leagues", () => {
  assertEquals(leagueOf("NFL-2611221800-TEN-DAL-PPRYDS"), "nfl");
  assertEquals(leagueOf("NBAF-2027"), "nba");
  assertEquals(leagueOf("CFBSEC26"), "ncaaf");
});
