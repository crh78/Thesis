"use client";
// One asset's page, like the iOS AssetView: price and a scrubbable chart over 1D / 1W / 1M / 1Y,
// what it is, the details that matter for a basket, the takes that hold it, and "Make a take with
// this" (the composer, with the asset kept in the basket).
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AssetLogo, price as fmtPrice, TakeListRow, type Asset } from "@/components/AssetBits";
import Chart from "@/components/Chart";
import { useComposer } from "@/components/Composer";
import type { FeedTake } from "@/components/TakeRow";
import { pct, rpcNow } from "@/lib/data";
import { useSession } from "@/lib/session";

type Range = "1D" | "1W" | "1M" | "1Y";
const RANGES: Range[] = ["1D", "1W", "1M", "1Y"];
const RANGE_LABEL: Record<Range, string> = { "1D": "today", "1W": "this week", "1M": "this month", "1Y": "this year" };

/** The page's extra fields sit on the asset (as the app's AssetPageDTO reads them). */
type PageAsset = Asset & { issuer?: string | null; fadeHow?: string | null; unavailableNote?: string | null };
type Page = { asset: PageAsset; price?: { usd: number; change24hPct?: number | null } | null; chart?: { points: number[][] } | null };

export default function AssetPage() {
  const { id } = useParams<{ id: string }>();
  const assetId = decodeURIComponent(id);
  const router = useRouter();
  const { assets } = useSession();
  const composer = useComposer();
  const [page, setPage] = useState<Page | null>(null);
  const [failed, setFailed] = useState(false);
  const [range, setRange] = useState<Range>("1M");
  const [chart, setChart] = useState<number[]>([]);
  const [loadingChart, setLoadingChart] = useState(false);
  const [scrub, setScrub] = useState<number | null>(null);
  const [takes, setTakes] = useState<FeedTake[]>([]);

  useEffect(() => {
    rpcNow<FeedTake[]>("asset_takes", { p_asset: assetId }).then(setTakes).catch(() => {});
  }, [assetId]);

  // The page with its chart for the range; a new range reloads just the chart's points.
  useEffect(() => {
    let live = true;
    setLoadingChart(true);
    setScrub(null);
    assets<Page>(`${assetId}?range=${range}`)
      .then((p) => {
        if (!live) return;
        setPage((old) => old ?? p);
        setChart((p.chart?.points ?? []).filter((pt) => pt.length > 1).map((pt) => pt[1]));
      })
      .catch(() => live && setFailed(true))
      .finally(() => live && setLoadingChart(false));
    return () => { live = false; };
  }, [assetId, range, assets]);

  if (failed && !page) {
    return (
      <main className="page">
        <button className="nav-back" onClick={() => router.back()}>‹ Back</button>
        <div className="empty"><h2>Couldn&apos;t load this</h2><p className="muted">Check your connection and try again.</p></div>
      </main>
    );
  }
  if (!page) return <main className="page"><p className="muted search-empty">Loading…</p></main>;

  const a = page.asset;
  const now = page.price?.usd ?? a.priceUsd ?? null;
  const shown = scrub != null && chart[scrub] != null ? chart[scrub] : now;
  const first = chart[0] ?? now;
  const change = scrub == null && range === "1D" ? (page.price?.change24hPct ?? a.change24hPct ?? null) : first && shown ? (shown / first - 1) * 100 : null;
  const up = (change ?? 0) >= 0;

  const details: [string, string][] = [["Type", a.kindLabel], ["Trades on", a.venue]];
  if (a.issuer) details.push(["Issued by", a.issuer]);
  details.push(["Fading it", a.fadeHow ?? "Can't be faded"]);
  if (a.maxLeverage) details.push(["Up to", `${Math.round(a.maxLeverage)}x`]);
  if (a.expiresAt) details.push(["Resolves", new Date(a.expiresAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })]);

  return (
    <main className="page asset">
      <button className="nav-back" onClick={() => router.back()}>‹ Back</button>
      <AssetLogo assetKey={a.key} name={a.name} kind={a.kind} size={52} />
      <h1 className="asset-name">{a.name}</h1>
      <div className="muted small">{a.symbol} · {a.kindLabel} · {a.venue}</div>
      {a.unavailableNote ? <div className="note-pill">{a.unavailableNote}</div> : null}

      {a.apyPct != null ? (
        <section style={{ marginTop: 18 }}>
          <div className="me-big">Earns {a.apyPct < 10 ? a.apyPct.toFixed(1) : Math.round(a.apyPct)}% a year</div>
          <div className="muted small">The rate moves with demand to borrow. Your cash stays yours.</div>
        </section>
      ) : now != null ? (
        <section style={{ marginTop: 18 }}>
          <div className="me-big">{fmtPrice(shown ?? now)}</div>
          {change != null ? <div className={`mono small ${up ? "up" : "down"}`} style={{ fontWeight: 600 }}>{pct(change)} {RANGE_LABEL[range]}</div> : null}
          {chart.length > 1 ? (
            <Chart values={chart} height={180} scrub={scrub} onScrub={setScrub} />
          ) : (
            <p className="muted small chart-none">{loadingChart ? "Loading…" : "No price history yet"}</p>
          )}
          <div className="segmented four" role="tablist" aria-label="Range" style={{ marginTop: 8 }}>
            {RANGES.map((r) => <button key={r} role="tab" aria-selected={range === r} className={range === r ? "on" : ""} onClick={() => setRange(r)}>{r}</button>)}
          </div>
        </section>
      ) : null}

      {a.available ? (
        <button className="obtn filled" style={{ marginTop: 20 }} onClick={() => composer.open({ seed: { id: a.id, name: a.name } })}>+ Make a take with this</button>
      ) : null}

      {a.about ? (
        <section className="asset-sec">
          <h2>What it is</h2>
          <p className="asset-about">{a.about}</p>
          {a.themes?.length ? <div className="chip-row">{a.themes.slice(0, 8).map((t) => <span key={t} className="topic-chip">{t}</span>)}</div> : null}
        </section>
      ) : null}

      <section className="asset-sec">
        <h2>Details</h2>
        {details.map(([k, v]) => (
          <div key={k} className="drow"><span className="muted">{k}</span><span>{v}</span></div>
        ))}
      </section>

      <section className="asset-sec">
        <h2>{takes.length ? `Takes with ${a.name}` : `No takes with ${a.name} yet`}</h2>
        {takes.map((t) => <TakeListRow key={t.id} take={t} />)}
      </section>
    </main>
  );
}
