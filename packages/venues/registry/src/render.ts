// Renders docs/liquidity.md from the registry. Generated: edit the script, not the doc.
import type { LiquidityClass, PythRef, Registry, SpotAsset } from "./build.ts";
import { COMMON_SOURCES, ISSUERS } from "./curated.ts";

const usd = (n: number | null | undefined, digits = 0) => (n === null || n === undefined || Number.isNaN(n) ? "–" : `$${n.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: digits })}`);
const compactUsd = (n: number | null | undefined) => {
  if (n === null || n === undefined || Number.isNaN(n)) return "–";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
};
const pct = (n: number | null | undefined, d = 2) => (n === null || n === undefined || Number.isNaN(n) ? "–" : `${n.toFixed(d)}%`);
const code = (s: string | null | undefined) => (s ? `\`${s}\`` : "–");
const esc = (s: string) => s.replace(/\|/g, "\\|");
const CLASS_LABEL: Record<LiquidityClass, string> = { tradeable: "**tradeable**", thin: "thin", "price-only": "price-only", "no-market": "no market", excluded: "excluded" };

function pythCell(p: { token: PythRef; underlying: PythRef }): string {
  const one = (r: PythRef) => (r ? `${code(r.symbol)} ${r.access === "free-onchain" ? "(free on-chain)" : r.access === "stale-onchain" ? "(push acct stale; key)" : "(key)"}` : null);
  return [one(p.token), one(p.underlying)].filter(Boolean).join("<br>") || "none";
}

function quoteCell(a: SpotAsset): string {
  const q = a.liquidity.quotes;
  if (!q) return "not quoted";
  return q
    .map((x) => {
      if (!x.routed) return "no route";
      return pct(x.costPct ?? Math.max(x.priceImpactPct ?? 0, x.impactVsSmallestPct ?? 0));
    })
    .join(" / ");
}

function tokenCell(a: SpotAsset): string {
  const t = a.token;
  const bits = [t.program];
  if (t.transferFeeBps) bits.push(`fee ${t.transferFeeBps / 100}%`);
  if (t.permanentDelegate) bits.push("perm. delegate");
  if (t.pausable) bits.push(t.paused ? "PAUSED" : "pausable");
  if (t.scaledUiMultiplier && t.scaledUiMultiplier !== 1) bits.push(`UI x${Number(t.scaledUiMultiplier.toFixed(4))}`);
  if (t.transferHookProgram) bits.push("hook");
  return bits.join(", ");
}

function spotTable(rows: SpotAsset[], withIssuer = true): string {
  if (!rows.length) return "_None._\n";
  const head = `| Symbol | Name | ${withIssuer ? "Issuer | " : ""}Mint | Token | Pyth | Buy cost $10 / $100 / $1k | Pooled liq. | Class |\n|---|---|${withIssuer ? "---|" : ""}---|---|---|---|---|---|\n`;
  return (
    head +
    rows
      .map((a) => `| ${esc(a.symbol)} | ${esc(a.name)} | ${withIssuer ? esc(a.issuer) + " | " : ""}${code(a.mint)} | ${tokenCell(a)} | ${pythCell(a.pyth)} | ${quoteCell(a)} | ${compactUsd(a.liquidity.jupiterPooledUsd)} | ${CLASS_LABEL[a.liquidity.class]} |`)
      .join("\n") +
    "\n"
  );
}

function restLine(rows: SpotAsset[], label: string, max = 60): string {
  if (!rows.length) return "";
  const names = rows.slice(0, max).map((a) => a.symbol).join(", ");
  return `- **${label} (${rows.length}):** ${names}${rows.length > max ? `, and ${rows.length - max} more (see \`assets.json\`)` : ""}.\n`;
}

function categorySection(r: Registry, title: string, filter: (a: SpotAsset) => boolean, intro: string, withIssuer = true): string {
  const rows = r.spot.filter(filter);
  const live = rows.filter((a) => a.liquidity.class === "tradeable" || a.liquidity.class === "thin");
  const priceOnly = rows.filter((a) => a.liquidity.class === "price-only");
  const none = rows.filter((a) => a.liquidity.class === "no-market");
  const excl = rows.filter((a) => a.liquidity.class === "excluded");
  let s = `### ${title}\n\n${intro}\n\n`;
  s += `${rows.length} assets: ${live.filter((a) => a.liquidity.class === "tradeable").length} tradeable, ${live.filter((a) => a.liquidity.class === "thin").length} thin, ${priceOnly.length} price-only, ${none.length} with no market${excl.length ? `, ${excl.length} excluded` : ""}.\n\n`;
  s += spotTable(live, withIssuer);
  s += "\n" + restLine(priceOnly, "Price-only") + restLine(none, "No market") + restLine(excl, "Excluded");
  return s + "\n";
}

export function renderMarkdown(r: Registry): string {
  const out: string[] = [];
  const when = r.generatedAt.replace("T", " ").replace(/\.\d+Z$/, " UTC");
  out.push(`# Liquidity registry\n\n_Generated ${when} by \`${r.generator}\`. Do not edit by hand: rerun the script. Machine-readable copy: [\`packages/venues/registry/assets.json\`](../packages/venues/registry/assets.json)._\n`);
  out.push(`Every asset Thesis could put in a basket, with liquidity measured live. Scope: what a user can trade from their own wallet without the issuer's KYC, plus the venues we already use (Phoenix, Kamino, Jupiter Lend, Collector Crypt) and Gemini prediction markets, whose legs are paper fills: Thesis places no Gemini orders; a leg's share of the stake is escrowed and returned, and its P&L counts only in the score.\n`);
  out.push(`## How to read this\n`);
  out.push(`- **Buy cost** is a USDC buy quoted live on Jupiter's swap API (\`/swap/v1/quote\`, \`maxAccounts=30\`, the cap the fork API routes trades with). It is the worst of three numbers, plus any Token-2022 transfer fee: Jupiter's \`priceImpactPct\`; the slippage against the $10 quote's rate; and the shortfall against Jupiter's USD price for the token (scaled by the token's UI multiplier). Proprietary AMMs and order books often report 0% impact, which is why the other two exist.`);
  out.push(`- **Class:** ${r.inputs.tradeableRule} This table measures that rule only. The live rule (the trade router, the settler's price floor and the catalog's tradeable flag) also needs at least $25k pooled liquidity (\`PRICEABLE_MIN_POOLED_USD\`, \`packages/venues/bank/src/route.ts\`), so a token marked tradeable here may still not be tradeable in the app.`);
  out.push(`- **Not quoted:** tokens with less than ${usd(r.inputs.quoteFloorUsd)} of pooled liquidity in Jupiter's token API (\`/tokens/v2/tag?query=verified\`) are not quoted, to stay inside the rate limit. Run with \`--quote-floor=0\` to quote them too.`);
  out.push(`- **Pyth:** feed symbols come from the keyless Hermes catalog (\`${COMMON_SOURCES.pythCatalog}\`). "free on-chain" means Pyth's sponsored push account on mainnet (shard 0 of the Core or Core-Compatible push program) updated within the last 4 days, which allows for weekends and market close, so any program can read it for free. "push acct stale" means the account exists but stopped updating (most equity feeds have). "key" means pull-only: the signed update must come from Hermes, which needs a Pyth API key (<${COMMON_SOURCES.pythKey}>). Each feed's \`access\` and push account are in \`assets.json\`.`);
  out.push(`- **Token:** program, and Token-2022 extensions that matter: transfer fee, permanent delegate (issuer can move or burn your tokens), pausable, scaled UI amount (wallet shows raw amount x multiplier), transfer hook.`);
  out.push(`- Inputs this run: Jupiter ${r.inputs.jupiter}; RPC ${r.inputs.rpc}; keys ${r.inputs.keys}.\n`);

  if (r.gaps.length) out.push(`### Gaps this run\n\n${r.gaps.map((g) => `- ${g}`).join("\n")}\n`);

  // Summary
  out.push(`## Summary\n`);
  const sum = (cat: string) => {
    const rows = r.spot.filter((a) => a.category === cat);
    const c = (k: LiquidityClass) => rows.filter((a) => a.liquidity.class === k).length;
    return `| ${cat} | ${rows.length} | ${c("tradeable")} | ${c("thin")} | ${c("price-only")} | ${c("no-market")} | ${c("excluded")} |`;
  };
  out.push(`| Category | Assets | Tradeable | Thin | Price-only | No market | Excluded |\n|---|---|---|---|---|---|---|\n${["stock", "pre-ipo", "leveraged", "commodity", "yield-token", "other-rwa"].map(sum).join("\n")}`);
  if (r.phoenix) {
    const m = r.phoenix.markets;
    out.push(`| Phoenix perps | ${m.length} | ${m.filter((x) => x.class === "tradeable").length} | ${m.filter((x) => x.class === "thin").length} | ${m.filter((x) => x.class === "price-only").length} | 0 | 0 |`);
  }
  out.push(`\nFor perps, "tradeable" means a $1,000 taker buy fills within 1% of mid on the live book.\n`);

  out.push(`## Spot tokens (Jupiter, user's own wallet)\n`);
  const issuerIntro = (tag: string) => {
    const i = ISSUERS[tag];
    return `Issuer: ${i.issuer}. ${i.restrictions.join(" ")} Sources: ${i.sources.map((s) => `<${s.url}>`).join(", ") || "unverified"}.`;
  };
  out.push(categorySection(r, "Tokenized stocks and ETFs: xStocks", (a) => a.issuerTag === "xstocks", issuerIntro("xstocks"), false));
  out.push(categorySection(r, "Tokenized stocks and ETFs: Ondo Global Markets", (a) => a.issuerTag === "ondo", issuerIntro("ondo"), false));
  out.push(categorySection(r, "Tokenized stocks and ETFs: Backpack Securities", (a) => a.issuerTag === "backpack", issuerIntro("backpack"), false));
  out.push(categorySection(r, "Tokenized stocks: Remora rStocks", (a) => a.issuerTag === "remora", issuerIntro("remora"), false));
  out.push(categorySection(r, "Pre-IPO tokens (PreStocks, Tessera)", (a) => a.category === "pre-ipo", `${issuerIntro("prestocks")}\n\nTessera: ${ISSUERS.tessera.restrictions.join(" ")}`));
  out.push(categorySection(r, "Leveraged equity tokens (SHIFT)", (a) => a.category === "leveraged", issuerIntro("shift"), false));
  out.push(categorySection(r, "Physical commodities", (a) => a.category === "commodity", "Tokens backed by metal in a vault. Gold and silver ETF tokens (GLDx, SLVon, and so on) are listed with the stocks above and tagged with the Commodities theme. Issuer mappings marked unverified were matched by name and Jupiter tag only."));
  out.push(categorySection(r, "Tokenized treasuries and yield tokens", (a) => a.category === "yield-token", "Permissionless on the secondary market. Primary mint and redeem usually need the issuer's KYC. Jupiter Lend receipts (jlUSDC and others) are covered under USDC yield."));
  out.push(`#### Excluded: permissioned treasuries and funds\n\nThese need KYC or an allowlisted wallet, so a user's wallet can't simply buy them. Not measured.\n\n| Symbol | Name | Issuer | Why excluded | Source |\n|---|---|---|---|---|\n${r.permissioned.map((p) => `| ${p.symbol} | ${p.name} | ${p.issuer} | ${p.why} | ${p.sources.map((s) => `<${s.url}>`).join(" ")} |`).join("\n")}\n\nSolana mint addresses for these are **unverified**: none is on Jupiter's verified list, and token search returns only look-alike tokens.\n`);
  out.push(categorySection(r, "Other real-world assets", (a) => a.category === "other-rwa", "Tokens Jupiter tags `rwa` or `stocks` that fit none of the groups above. Issuers are unverified unless stated."));

  // Phoenix
  if (r.phoenix) {
    const p = r.phoenix;
    out.push(`## Phoenix perps\n\n_Measured ${p.measuredAt}._ ${p.restrictions.join(" ")} Program \`EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih\`; collateral mint \`${p.collateralMint}\`. A short is an Ask-side market order. Exchange status flags: ${p.features.join(", ")}.\n\nSources: ${p.sources.map((s) => `<${s.url}>`).join(", ")}.\n`);
    out.push(`Max leverage is the first leverage tier. Open interest is base units times mid. Depth is resting size within 1% of mid on each side. Buy impact walks the live asks from mid.\n`);
    const order = ["equities", "commodities", "crypto"];
    for (const cls of order) {
      const ms = p.markets.filter((m) => m.assetClass === cls).sort((a, b) => (b.openInterestUsd ?? 0) - (a.openInterestUsd ?? 0));
      if (!ms.length) continue;
      out.push(`### ${cls[0].toUpperCase() + cls.slice(1)} (${ms.length})\n\n| Symbol | Market | Max lev. | Open interest | Depth ±1% (bid / ask) | Spread | Buy impact $100 / $1k | Pyth | Class |\n|---|---|---|---|---|---|---|---|---|\n${ms
        .map((m) => `| ${m.symbol} | ${code(m.marketPubkey)} | ${m.maxLeverage}x${m.isolatedOnly ? " (isolated)" : ""} | ${compactUsd(m.openInterestUsd)} | ${m.depthUsdWithin1Pct ? `${compactUsd(m.depthUsdWithin1Pct.bids)} / ${compactUsd(m.depthUsdWithin1Pct.asks)}` : "–"} | ${m.spreadBps === null ? "–" : `${m.spreadBps.toFixed(1)} bps`} | ${pct(m.buyImpactPct["100"])} / ${m.buyImpactPct["1000"] == null ? (m.mid == null ? "–" : "book too thin") : pct(m.buyImpactPct["1000"])} | ${m.pyth ? `${code(m.pyth.symbol)} (${m.pyth.access === "free-onchain" ? "free on-chain" : "key"})` : "none"} | ${CLASS_LABEL[m.class]} |`)
        .join("\n")}\n`);
    }
  }

  // Yield
  if (r.usdcYield) {
    const y = r.usdcYield;
    out.push(`## USDC yield\n\n_Measured ${y.measuredAt}._ Kamino lists ${y.kaminoUsdcVaultCount} USDC Earn vaults; the top ones by TVL are below, with Jupiter Lend's USDC Earn. Deposits come from the user's wallet in the same transaction as our receipt.\n\n| Venue | Vault | Address | Share mint | TVL | APY now | APY 7d | APY 30d | Fees | Note |\n|---|---|---|---|---|---|---|---|---|---|\n${y.vaults
      .map((v) => `| ${v.venue} | ${esc(v.name)} | ${code(v.address)} | ${code(v.shareMint)} | ${compactUsd(v.tvlUsd)} | ${pct(v.apyPct)} | ${pct(v.apy7dPct)} | ${pct(v.apy30dPct)} | ${v.feesNote ?? "–"} | ${v.apyUnitNote} |`)
      .join("\n")}\n\nSources: ${y.sources.map((s) => `<${s.url}>`).join(", ")}.\n`);
  }

  // Cards
  if (r.cards) {
    const c = r.cards;
    out.push(`## Collector Crypt cards\n\n_Measured ${c.measuredAt}._ ${c.indexedCards.toLocaleString()} cards indexed; **${c.listedAllMarkets.toLocaleString()} listed for sale** (${c.listedOnCollectorCrypt.toLocaleString()} on Collector Crypt itself, the rest mirrored from Magic Eden). Token standard: ${c.tokenStandards}; in the ${c.scanned.toLocaleString()} Collector Crypt listings scanned: ${Object.entries(c.standards).map(([k, v]) => `${k} ${v}`).join(", ")}. Listing currency: ${Object.entries(c.currencies).map(([k, v]) => `${k} ${v}`).join(", ")}. Median insured value ${usd(c.insuredValueUsd.median)} (90th percentile ${usd(c.insuredValueUsd.p90)}). Marketplace program \`${c.marketplaceProgram}\`.\n\n${c.restrictions.map((x) => `- ${x}`).join("\n")}\n- **How to fetch the current list:** ${c.howToFetch}\n\n| Category | Listed | Priced in USDC | Min | Median | 90th pct | Max |\n|---|---|---|---|---|---|---|\n${c.categories
      .map((k) => `| ${esc(k.category)} | ${k.listed} | ${k.usdcListed} | ${usd(k.minUsd, 2)} | ${usd(k.medianUsd, 2)} | ${usd(k.p90Usd, 2)} | ${usd(k.maxUsd, 2)} |`)
      .join("\n")}\n\nSources: ${c.sources.map((s) => `<${s.url}>`).join(", ")}.\n`);
  }

  // Gemini
  if (r.gemini) {
    const g = r.gemini;
    out.push(`## Gemini prediction markets (paper fills)\n\n_Measured ${g.measuredAt}._ Paper fills on Gemini's public market data: Thesis places no Gemini orders and users never link Gemini; entry is at the side's ask, exit at 1 or 0 once resolved, else at the bid. ${g.restrictions.filter((x) => !/^Orders need/.test(x)).join(" ")} ${g.totalActiveEvents.toLocaleString()} active events. The categories endpoint lists: ${g.listedCategories.join(", ")}.\n\n- **How to list them:** ${g.howToList}\n\n| Category | Active events | Contracts | Total volume | 24h volume | Busiest events (24h) |\n|---|---|---|---|---|---|\n${g.categories
      .map((k) => `| ${esc(k.category)} | ${k.activeEvents} | ${k.activeContracts} | ${compactUsd(k.volumeUsd)} | ${compactUsd(k.volume24hUsd)} | ${k.top.map((e) => `${esc(e.title)} (\`${e.ticker}\`)`).join("; ")} |`)
      .join("\n")}\n\nVolume is Gemini's \`volume\` field, read as USD (unit unverified). Sources: ${g.sources.map((s) => `<${s.url}>`).join(", ")}.\n`);
  }

  // Candidates
  out.push(`## Good basket candidates\n\nLiquid enough for a one-signature leg today, grouped by theme. Spot means tradeable on Jupiter ($100 buy under 1%) **and** a $1,000 buy under 2%, which drops tiny order books that fill $100 and then run out. Perp means a Phoenix market where a $1,000 buy fills within 1% of mid. The catalog keeps each asset's US flags (\`us_persons\`), but geoblocking is off for now, so everything is offered to every account. Tradeable assets with no theme mapping in \`curated.ts\` are not listed here.\n`);
  const themes = new Map<string, { spot: string[]; perp: string[] }>();
  for (const a of r.spot.filter((x) => x.liquidity.class === "tradeable" && (x.liquidity.buyCost1000Pct ?? Infinity) < 2)) for (const t of a.themes) {
    const e = themes.get(t) ?? { spot: [], perp: [] };
    e.spot.push(`${a.symbol} (${pct(a.liquidity.buyCost100Pct)})`);
    themes.set(t, e);
  }
  for (const m of r.phoenix?.markets.filter((x) => x.class === "tradeable") ?? []) for (const t of m.themes) {
    const e = themes.get(t) ?? { spot: [], perp: [] };
    e.perp.push(`${m.symbol} (${m.maxLeverage}x)`);
    themes.set(t, e);
  }
  const yieldBest = r.usdcYield?.vaults.slice().sort((a, b) => b.tvlUsd - a.tvlUsd)[0];
  out.push(`| Theme | Spot (cost of a $100 buy) | Phoenix perps (max leverage) |\n|---|---|---|\n${[...themes.entries()]
    .sort((a, b) => b[1].spot.length + b[1].perp.length - (a[1].spot.length + a[1].perp.length))
    .map(([t, e]) => `| ${t} | ${e.spot.join(", ") || "–"} | ${e.perp.join(", ") || "–"} |`)
    .join("\n")}\n`);
  const cryptoPerps = r.phoenix?.markets.filter((m) => m.class === "tradeable" && m.assetClass === "crypto").map((m) => m.symbol) ?? [];
  if (cryptoPerps.length) out.push(`- **Crypto perps** (tradeable on Phoenix): ${cryptoPerps.join(", ")}.`);
  if (yieldBest) out.push(`- **Cash leg:** ${yieldBest.venue} ${yieldBest.name} (${compactUsd(yieldBest.tvlUsd)} TVL, ${pct(yieldBest.apyPct)} APY).`);
  if (r.gemini) out.push(`- **Prediction legs (paper fills on Gemini's prices):** ${r.gemini.categories.slice(0, 6).map((k) => `${k.category} (${k.activeEvents})`).join(", ")}.`);
  out.push("");

  // Unverified roll-up
  const unv = new Map<string, number>();
  for (const a of r.spot) for (const u of a.unverified) unv.set(u, (unv.get(u) ?? 0) + 1);
  const issuerUnv = Object.values(r.issuers).flatMap((i) => (i.unverified ?? []).map((u) => `${i.issuer}: ${u}`));
  out.push(`## Unverified\n\n${issuerUnv.map((u) => `- ${u}`).join("\n")}\n${[...unv.entries()].sort((a, b) => b[1] - a[1]).map(([u, n]) => `- ${u} (${n} asset${n > 1 ? "s" : ""})`).join("\n")}\n- Gemini's regulated venue and US availability.\n- Jupiter Lend's \`totalRate\` unit (read as basis points).\n- The oracle Phoenix uses for equity marks.\n`);

  out.push(`## Sources\n\n${Object.values(COMMON_SOURCES).map((u) => `- <${u}>`).join("\n")}\n- Per-asset sources (issuer pages, Jupiter token pages, Solscan mint pages) are in \`assets.json\` under \`sources\`.\n`);
  return out.join("\n");
}
