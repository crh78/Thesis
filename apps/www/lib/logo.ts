// Which logo an asset shows, by ticker and kind. Shared by the app's components (AssetBits) and the
// server-drawn pictures (the X bot's basket card, /d/<id>/basket.png), so both pick the same one.
import { isCardKind } from "@/lib/data";
import LOGOS from "@/lib/logos.json";

const CRYPTO = new Set("BTC ETH SOL XRP BNB DOGE ADA LINK AVAX ENA SUI TON HYPE JUP TRX DOT LTC BCH NEAR APT ARB OP PEPE WIF BONK SHIB UNI AAVE XLM HBAR ATOM FIL INJ TIA SEI PYTH JTO RNDR RENDER TAO ONDO PENGU TRUMP FARTCOIN POPCAT XMR ETC ICP MKR LDO CRV ZEC KAITO VIRTUAL RAY".split(" "));
// Private companies (pre-IPO) by their site, for its icon.
const SITES: Record<string, string> = {
  SPACEX: "spacex.com", OPENAI: "openai.com", ANTHROPIC: "anthropic.com", KALSHI: "kalshi.com", ANDURIL: "anduril.com",
  NEURALINK: "neuralink.com", POLYMARKET: "polymarket.com", OURA: "ouraring.com", FIGUREAI: "figure.ai", XAI: "x.ai",
  STRIPE: "stripe.com", DATABRICKS: "databricks.com", DISCORD: "discord.com", RIPPLING: "rippling.com", REVOLUT: "revolut.com", PERPLEXITY: "perplexity.ai",
};

/** Collector Crypt's site icon, from the same public icon endpoint as the private companies' (SITES). */
export const COLLECTOR_CRYPT_LOGO = "https://www.google.com/s2/favicons?domain=collectorcrypt.com&sz=128";

const CACHED = LOGOS as Record<string, string>;

/** The logo by ticker: the app's own copy for stocks and ETFs (`pnpm logos:cache`), else the same
 * public image endpoints the iOS app uses (nothing about you is sent), else null (a monogram). */
export function logoUrl(key: string | null, kind: string): string | null {
  if (isCardKind(kind)) return COLLECTOR_CRYPT_LOGO;
  const t = key?.toUpperCase();
  if (!t || !/^[A-Z0-9.]{1,12}$/.test(t)) return null;
  if (CACHED[t] && !kind.toLowerCase().startsWith("pre")) return `/logos/${CACHED[t]}`;
  if (SITES[t]) return `https://www.google.com/s2/favicons?domain=${SITES[t]}&sz=128`;
  if (kind.toLowerCase().startsWith("pre")) return null;
  return CRYPTO.has(t) ? `https://assets.coincap.io/assets/icons/${t.toLowerCase()}@2x.png` : `https://financialmodelingprep.com/image-stock/${t}.png`;
}
