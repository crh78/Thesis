"use client";
// Assets and compact take rows, after the iOS AssetLogo, AssetRow and TakeListRow.
import Link from "next/link";
import { useState } from "react";
import { isDeleted, DELETED_NAME, pct, topicImage } from "@/lib/data";
import type { FeedTake } from "./TakeRow";

export type Asset = {
  id: string;
  key: string;
  symbol: string;
  name: string;
  kind: string;
  kindLabel: string;
  venue: string;
  about?: string | null;
  themes?: string[] | null;
  canShort: boolean;
  apyPct?: number | null;
  maxLeverage?: number | null;
  expiresAt?: string | null;
  available: boolean;
  priceUsd?: number | null;
  change24hPct?: number | null;
};

/** "$187.61", "$4,056.68", "$0.0042", like the app's Fmt.price. */
export function price(v: number): string {
  if (v < 0.01) return "$" + v.toPrecision(2);
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function assetSubtitle(a: Asset): string {
  if (a.apyPct != null) return `${a.symbol} · Earns ${a.apyPct < 10 ? a.apyPct.toFixed(1) : Math.round(a.apyPct)}% a year`;
  if (a.kind === "prediction" && a.expiresAt) return `Prediction · resolves ${new Date(a.expiresAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
  return `${a.symbol} · ${a.kindLabel}`;
}

const CRYPTO = new Set("BTC ETH SOL XRP BNB DOGE ADA LINK AVAX ENA SUI TON HYPE JUP TRX DOT LTC BCH NEAR APT ARB OP PEPE WIF BONK SHIB UNI AAVE XLM HBAR ATOM FIL INJ TIA SEI PYTH JTO RNDR RENDER TAO ONDO PENGU TRUMP FARTCOIN POPCAT XMR ETC ICP MKR LDO CRV ZEC KAITO VIRTUAL".split(" "));
const SITES: Record<string, string> = {
  SPACEX: "spacex.com", OPENAI: "openai.com", ANTHROPIC: "anthropic.com", KALSHI: "kalshi.com", ANDURIL: "anduril.com",
  NEURALINK: "neuralink.com", POLYMARKET: "polymarket.com", OURA: "ouraring.com", FIGUREAI: "figure.ai", XAI: "x.ai",
  STRIPE: "stripe.com", DATABRICKS: "databricks.com", DISCORD: "discord.com", RIPPLING: "rippling.com", REVOLUT: "revolut.com", PERPLEXITY: "perplexity.ai",
};

/** Cash, predictions, cards and metals get a symbol, not a logo (as the app). */
function symbol(kind: string, key: string | null): { glyph: string; tint: string } | null {
  const k = kind.toLowerCase();
  if (k === "yield" || k.startsWith("earns") || k === "cash") return { glyph: "$", tint: "var(--up)" };
  if (k.startsWith("prediction")) return { glyph: "%", tint: "#8C6BF0" };
  if (k === "card" || k === "cards") return { glyph: "▣", tint: "#D65282" };
  if (key?.toUpperCase() === "XAU") return { glyph: "Au", tint: "#DBAD38" };
  if (key?.toUpperCase() === "XAG") return { glyph: "Ag", tint: "#C7C7C7" };
  return null;
}

/** The logo by ticker from the same public image endpoints the app uses (nothing about you is sent), else a monogram. */
function logoUrl(key: string | null, kind: string): string | null {
  const t = key?.toUpperCase();
  if (!t || !/^[A-Z0-9.]{1,12}$/.test(t)) return null;
  if (SITES[t]) return `https://www.google.com/s2/favicons?domain=${SITES[t]}&sz=128`;
  if (kind.toLowerCase().startsWith("pre")) return null;
  return CRYPTO.has(t) ? `https://assets.coincap.io/assets/icons/${t.toLowerCase()}@2x.png` : `https://financialmodelingprep.com/image-stock/${t}.png`;
}

/** True when a logo's visible pixels are almost all near-white (it would vanish on a white tile). */
function isLightLogo(img: HTMLImageElement): boolean {
  try {
    const n = 24;
    const c = document.createElement("canvas");
    c.width = n; c.height = n;
    const ctx = c.getContext("2d");
    if (!ctx) return false;
    ctx.drawImage(img, 0, 0, n, n);
    const d = ctx.getImageData(0, 0, n, n).data;
    let seen = 0, light = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 80) continue;
      seen++;
      if (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2] > 225) light++;
    }
    return seen > 0 && light / seen > 0.9;
  } catch {
    return false;
  }
}

export function AssetLogo({ assetKey, name, kind, size = 44 }: { assetKey: string | null; name: string; kind: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  const [light, setLight] = useState(false);
  const sym = symbol(kind, assetKey);
  const url = sym ? null : logoUrl(assetKey, kind);
  const style = { width: size, height: size, fontSize: size * 0.36 };
  if (sym) return <span className="alogo" style={{ ...style, color: sym.tint, background: `color-mix(in srgb, ${sym.tint} 18%, transparent)` }} aria-hidden>{sym.glyph}</span>;
  if (url && !failed) {
    // Stock logos (FMP, which sends CORS headers) can be white on transparent, invisible on the white
    // tile (Roblox): those get the dark tile. Other hosts load without crossOrigin, as before.
    const fmp = url.startsWith("https://financialmodelingprep.com/");
    return (
      <span className={`alogo alogo-img${light ? " light-logo" : ""}`} style={style} aria-hidden>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt="" crossOrigin={fmp ? "anonymous" : undefined} onError={() => setFailed(true)} onLoad={fmp ? (e) => setLight(isLightLogo(e.currentTarget)) : undefined} />
      </span>
    );
  }
  const mono = (assetKey && /^[A-Za-z]/.test(assetKey) ? assetKey : name).replace(/[^A-Za-z0-9]/g, "").slice(0, 3).toUpperCase();
  return <span className="alogo" style={style} aria-hidden>{mono}</span>;
}

export function AssetRow({ asset }: { asset: Asset }) {
  return (
    <Link href={`/asset/${asset.id}`} className={`arow${asset.available ? "" : " unavailable"}`}>
      <AssetLogo assetKey={asset.key} name={asset.name} kind={asset.kind} />
      <span className="arow-main">
        <b>{asset.name}</b>
        <span className="muted small">{asset.available ? assetSubtitle(asset) : "Not available where you live yet"}</span>
      </span>
      {asset.priceUsd != null ? (
        <span className="arow-num">
          <b className="mono">{price(asset.priceUsd)}</b>
          {asset.change24hPct != null ? <span className={`mono small ${asset.change24hPct >= 0 ? "up" : "down"}`}>{pct(asset.change24hPct)}</span> : null}
        </span>
      ) : null}
    </Link>
  );
}

function MiniSpark({ values, up }: { values: number[]; up: boolean }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const d = values.map((v, i) => `${i ? "L" : "M"}${((i / (values.length - 1)) * 56).toFixed(1)} ${(2 + (1 - (v - min) / span) * 16).toFixed(1)}`).join("");
  return <svg viewBox="0 0 56 20" width="56" height="20" aria-hidden><path d={d} fill="none" stroke={up ? "var(--up)" : "var(--down)"} strokeWidth="1.6" strokeLinejoin="round" /></svg>;
}

const RISK: Record<string, string> = { low: "LOW", medium: "MED", high: "HIGH" };

/** A compact take with its topic tile: Search and an asset's takes. */
export function TakeListRow({ take }: { take: FeedTake }) {
  const up = take.ret >= 0;
  return (
    <Link href={`/t/${take.id}`} className="tlrow">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="tile tile-sq" src={topicImage(take.topic)} alt="" />
      <span className="tlrow-main">
        <span className="tlrow-claim">{take.claim}</span>
        <span className="mono muted" style={{ fontSize: 11 }}>
          {isDeleted(take.author) ? DELETED_NAME : `@${take.author.handle}`} · {RISK[take.risk] ?? take.risk}{take.tags?.length ? ` · ${take.tags.join(" / ").toUpperCase()}` : ""}
        </span>
      </span>
      <span className="tlrow-num">
        <MiniSpark values={take.history ?? []} up={up} />
        <b className={`mono ${up ? "up" : "down"}`}>{pct(take.ret)}</b>
      </span>
    </Link>
  );
}
