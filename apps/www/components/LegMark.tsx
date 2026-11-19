"use client";
// A basket row's mark: the pick's logo in a frame of its color, shaped by what kind of pick it is,
// so a basket's mix reads at a glance: a square for stocks and funds, a diamond for perps
// (leveraged legs), a circle for predictions, a hexagon for cash that earns interest, and a card
// for trading cards.
import { useState } from "react";
import { isLightLogo, logoUrl, symbol } from "./AssetBits";

export type LegShape = "square" | "diamond" | "circle" | "hex" | "card";

/** The frame for a leg's kind ("Stock", "Stock · 2x", "Prediction · Yes", "Earns interest", "Cards"…). */
export function legShape(kind: string, name = ""): LegShape {
  const k = kind.toLowerCase();
  if (/·\s*[\d.]+x\b/.test(k) || /\bperp/.test(k) || /\bperp\b/i.test(name)) return "diamond";
  if (k.startsWith("prediction")) return "circle";
  if (k.startsWith("earns") || k === "yield" || k === "cash") return "hex";
  if (k === "card" || k === "cards") return "card";
  return "square";
}

export default function LegMark({ assetKey, name, kind, color }: { assetKey: string | null; name: string; kind: string; color: string }) {
  const [failed, setFailed] = useState(false);
  const [light, setLight] = useState(false);
  const shape = legShape(kind, name);
  const sym = symbol(kind, assetKey);
  const url = sym ? null : logoUrl(assetKey, kind);
  const sameOrCors = !!url && (url.startsWith("/") || url.startsWith("https://financialmodelingprep.com/"));
  const mono = (assetKey && /^[A-Za-z]/.test(assetKey) ? assetKey : name).replace(/[^A-Za-z0-9]/g, "").slice(0, 3).toUpperCase();
  const inner = sym ? (
    <span className="lm-glyph" style={{ color: sym.tint }}>{sym.glyph}</span>
  ) : url && !failed ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="" crossOrigin={sameOrCors ? "anonymous" : undefined} onError={() => setFailed(true)}
      onLoad={sameOrCors ? (e) => setLight(isLightLogo(e.currentTarget)) : undefined} />
  ) : (
    <span className="lm-glyph lm-mono">{mono}</span>
  );
  return (
    <span className={`legmark lm-${shape}${sym ? " lm-sym" : ""}${light ? " lm-light" : ""}`} style={{ "--lm": color } as React.CSSProperties} aria-hidden>
      <span className="lm-in">{inner}</span>
    </span>
  );
}
