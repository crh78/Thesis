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
  const settleTimer = useRef<number | undefined>(undefined);
  /** The swatch tapped, while the rail scrolls to it. */
  const picking = useRef<number | null>(null);
  const n = useCountUp(d.ret);
  const shown = fmt(n, d.pct, Math.abs(n - d.ret) < 1e-6);

  /** How far card `i`'s middle is from the rail's middle, in px (measured on screen, so the rail's
   * own position and the cards' scaling don't skew it). */
  function offCenter(i: number): number | null {
    const r = rail.current;
    const el = r?.children[i] as HTMLElement | undefined;
    if (!r || !el) return null;
    const rr = r.getBoundingClientRect(), er = el.getBoundingClientRect();
    return er.left + er.width / 2 - (rr.left + rr.width / 2);
  }

  // Start on the theme from the link.
  useEffect(() => {
    const d = offCenter(THEMES.findIndex((t) => t.id === initial));
    if (d != null && rail.current) rail.current.scrollLeft += d;
  }, [initial]);

  /** The card nearest the middle. */
  function centered(): number {
    let best = 0;
    let dist = Infinity;
    THEMES.forEach((_, i) => {
      const dd = Math.abs(offCenter(i) ?? Infinity);
      if (dd < dist) { dist = dd; best = i; }
    });
    return best;
  }

  // Once the rail stops: the centered card is the theme, and the link follows so Share sends that
  // one. Rewriting the URL mid-scroll cut a smooth scroll short (a tapped swatch snapped back).
  function settle() {
    picking.current = null;
    const next = THEMES[centered()].id;
    setTheme(next);
    const url = new URL(window.location.href);
    if (next === "glow") url.searchParams.delete("theme");
    else url.searchParams.set("theme", next);
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, "", url);
  }

  // Swiping: the swatch follows the card passing the middle. Scrolling to a tapped swatch: that
  // swatch stays lit on the way, not each card it passes.
  function onScroll() {
    if (picking.current == null) {
      const next = THEMES[centered()].id;
      if (next !== theme) setTheme(next);
    }
    window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(settle, 160);
  }

  function pick(i: number) {
    picking.current = i;
    setTheme(THEMES[i].id);
    const d = offCenter(i);
    if (d) rail.current?.scrollBy({ left: d, behavior: "smooth" });
    // Settles even if no scroll comes (already there, or a smooth scroll that never ran).
    window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(settle, 900);
  }

  // A holder's P&L card says whose take it is; the take's own card brags for its author.
  const whose = d.holder?.author && d.holder.author !== d.handle ? ` on @${d.holder.author}'s take` : "";
  const shareText = d.holder
    ? `I'm ${d.pct}${whose}${d.holder.side === "fade" ? " (faded)" : ""}: ${d.claim}`
    : d.called ? `Called it. ${d.claim} ${d.pct}` : `${d.claim} (${d.pct} so far)`;

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
