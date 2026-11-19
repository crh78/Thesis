"use client";
// A take's logo: a pie of its picks, each slice sized by its weight and showing that asset's logo.
// Predictions, cash, cards and metals show their symbol on a tinted slice (as AssetLogo does), a
// logo that's white on transparent gets a dark slice, and a logo that doesn't load shows the
// ticker's first letters.
import { useEffect, useId, useState } from "react";
import { isLightLogo, logoUrl, symbol } from "./AssetBits";

export type LogoLeg = { key: string | null; name: string; kind: string; weight: number };

const R = 50;
const point = (a: number, r = R) => `${(50 + r * Math.cos(a)).toFixed(2)} ${(50 + r * Math.sin(a)).toFixed(2)}`;
const mono = (l: LogoLeg) => (l.key && /^[A-Za-z]/.test(l.key) ? l.key : l.name).replace(/[^A-Za-z0-9]/g, "").slice(0, 3).toUpperCase();

export default function TakeLogo({ legs, size = 44 }: { legs: LogoLeg[]; size?: number }) {
  const uid = useId().replace(/:/g, "");
  const [light, setLight] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const urls = legs.map((l) => (symbol(l.kind, l.key) ? null : logoUrl(l.key, l.kind)));

  // Which logos are white on transparent (they'd vanish on a white slice), and which don't load.
  const urlKey = urls.join("|");
  useEffect(() => {
    let live = true;
    for (const url of new Set(urls.filter((u): u is string => !!u))) {
      const img = new Image();
      const sameOrCors = url.startsWith("/") || url.startsWith("https://financialmodelingprep.com/");
      if (sameOrCors) img.crossOrigin = "anonymous";
      img.onload = () => { if (live && sameOrCors && isLightLogo(img)) setLight((s) => new Set(s).add(url)); };
      img.onerror = () => { if (live) setFailed((s) => new Set(s).add(url)); };
      img.src = url;
    }
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlKey]);

  const total = legs.reduce((s, l) => s + l.weight, 0) || 1;
  const one = legs.length === 1;
  let a0 = -Math.PI / 2;
  const slices = legs.map((l, i) => {
    const sweep = (l.weight / total) * Math.PI * 2;
    const a1 = a0 + sweep, mid = (a0 + a1) / 2;
    const d = one ? "M0 0h100v100H0Z" : `M50 50L${point(a0)}A${R} ${R} 0 ${sweep > Math.PI ? 1 : 0} 1 ${point(a1)}Z`;
    // The logo sits at the slice's middle, as big as the slice is wide there.
    const rc = one ? 0 : sweep > Math.PI ? R * 0.3 : R * 0.56;
    const chord = one || sweep >= Math.PI ? 2 * R : 2 * rc * Math.sin(sweep / 2);
    const s = Math.max(14, Math.min(46, chord * 0.62));
    const cx = 50 + rc * Math.cos(mid), cy = 50 + rc * Math.sin(mid);
    a0 = a1;
    return { l, i, d, s, cx, cy, start: a1 - sweep, sym: symbol(l.kind, l.key), url: urls[i] };
  });

  return (
    <svg className="take-logo" viewBox="0 0 100 100" width={size} height={size} aria-hidden>
      <defs>
        <clipPath id={`${uid}-c`}><circle cx="50" cy="50" r="50" /></clipPath>
        {slices.map((x) => <clipPath key={x.i} id={`${uid}-${x.i}`}><path d={x.d} /></clipPath>)}
      </defs>
      <g clipPath={`url(#${uid}-c)`}>
        {slices.map((x) => {
          const url = x.url && !failed.has(x.url) ? x.url : null;
          const bg = x.sym ? `color-mix(in srgb, ${x.sym.tint} 22%, #0d0f13)` : url && light.has(url) ? "#1b1e24" : "#fff";
          return (
            <g key={x.i} clipPath={`url(#${uid}-${x.i})`}>
              <rect width="100" height="100" style={{ fill: bg }} />
              {x.sym ? (
                <text x={x.cx} y={x.cy} dy=".35em" textAnchor="middle" fontSize={x.s * 0.7} style={{ fill: x.sym.tint, fontFamily: "var(--font-mono)" }}>{x.sym.glyph}</text>
              ) : url ? (
                <image href={url} x={x.cx - x.s / 2} y={x.cy - x.s / 2} width={x.s} height={x.s} preserveAspectRatio="xMidYMid meet" />
              ) : (
                <text x={x.cx} y={x.cy} dy=".35em" textAnchor="middle" fontSize={x.s * 0.42} style={{ fill: "#0f1419", fontFamily: "var(--font-mono)", fontWeight: 600 }}>{mono(x.l)}</text>
              )}
            </g>
          );
        })}
        {one ? null : (
          <g style={{ stroke: "var(--bg)" }} strokeWidth="2.4">
            {slices.map((x) => <line key={x.i} x1="50" y1="50" x2={50 + R * Math.cos(x.start)} y2={50 + R * Math.sin(x.start)} />)}
          </g>
        )}
      </g>
    </svg>
  );
}
