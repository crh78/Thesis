"use client";
// Swipe through the card's themes like camera filters, then share the one on screen. The theme
// rides along in the link (?theme=gold), so the link preview friends see is that same card.
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import CalledCard from "@/components/CalledCard";
import ShareButton from "@/components/ShareButton";
import { type CardData, THEMES, type ThemeId } from "@/lib/called";

function useCountUp(target: number, ms = 1100) {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return setV(target);
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      setV(target * (1 - Math.pow(1 - k, 3)));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

const fmt = (x: number, final: string, done: boolean) => {
  if (done) return final;
  const v = Math.abs(x).toFixed(1);
  return `${x >= 0 || Number(v) === 0 ? "+" : "−"}${v}%`;
};

export default function CalledStudio({ d, initial }: { d: CardData; initial: ThemeId }) {
  const [theme, setTheme] = useState<ThemeId>(initial);
  const rail = useRef<HTMLDivElement>(null);
  const n = useCountUp(d.ret);
  const shown = fmt(n, d.pct, Math.abs(n - d.ret) < 1e-6);

  // Start on the theme from the link.
  useEffect(() => {
    const i = THEMES.findIndex((t) => t.id === initial);
    const el = rail.current?.children[i] as HTMLElement | undefined;
    if (el && rail.current) rail.current.scrollLeft = el.offsetLeft - (rail.current.clientWidth - el.clientWidth) / 2;
  }, [initial]);

  // Whichever card is centered is the theme; keep it in the URL so Share sends that one.
  function onScroll() {
    const r = rail.current;
    if (!r) return;
    const mid = r.scrollLeft + r.clientWidth / 2;
    let best = 0;
    let dist = Infinity;
    Array.from(r.children).forEach((c, i) => {
      const el = c as HTMLElement;
      const dd = Math.abs(el.offsetLeft + el.clientWidth / 2 - mid);
      if (dd < dist) { dist = dd; best = i; }
    });
    const next = THEMES[best].id;
    if (next !== theme) {
      setTheme(next);
      const url = new URL(window.location.href);
      if (next === "glow") url.searchParams.delete("theme");
      else url.searchParams.set("theme", next);
      window.history.replaceState(null, "", url);
    }
  }

  function pick(i: number) {
    const r = rail.current;
    const el = r?.children[i] as HTMLElement | undefined;
    if (r && el) r.scrollTo({ left: el.offsetLeft - (r.clientWidth - el.clientWidth) / 2, behavior: "smooth" });
  }

  const shareText = d.called ? `Called it. ${d.claim} ${d.pct}` : `${d.claim} (${d.pct} so far)`;

  return (
    <>
      <div className="studio-rail" ref={rail} onScroll={onScroll}>
        {THEMES.map((t) => (
          <div className={`studio-slide ${t.id === theme ? "on" : ""}`} key={t.id} aria-label={`${t.name} card`}>
            <CalledCard d={d} theme={t.id} shown={shown} />
          </div>
        ))}
      </div>

      <div className="studio-name caps">{THEMES.find((t) => t.id === theme)?.name}</div>
      <div className="studio-swatches" role="tablist" aria-label="Card style">
        {THEMES.map((t, i) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={t.id === theme}
            aria-label={t.name}
            className={`swatch ${t.id === theme ? "on" : ""}`}
            style={{ background: t.swatch }}
            onClick={() => pick(i)}
          />
        ))}
      </div>

      <div className="actions studio-actions">
        {d.called ? (
          <span className="btn closed" aria-disabled="true">Closed</span>
        ) : (
          <Link href={`/t/${d.id}`} className="btn back">Trade it</Link>
        )}
        <ShareButton text={shareText} label="Share ↗" className="btn light" />
      </div>
      <Link href={`/t/${d.id}`} className="studio-more muted small">See the take →</Link>
    </>
  );
}
