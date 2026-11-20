// A chat bot's draft as a picture: the claim, a donut of its picks in the app's series colors, and
// each pick's logo, name and weight. The X bot attaches it to its replies (apps/x), so a basket
// reads at a glance without a link. Drawn here from the draft's own data, never by a model.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { basketFrom, type Leg } from "@/lib/compose";
import { assetKeys, getDraft, isCardKind, SERIES } from "@/lib/data";
import LOGOS from "@/lib/logos.json";
import { INK, ogCache, ogFonts } from "@/lib/og";

export const revalidate = 300;

const W = 1200;
const H = 675;
const CACHED = LOGOS as Record<string, string>;
const CARD_LOGO = "https://www.google.com/s2/favicons?domain=collectorcrypt.com&sz=128";

/** A logo as a data URL: our cached copy, else the public stock-logo endpoint the app uses; null: none. */
async function logoData(ticker: string | null, kind: string): Promise<string | null> {
  const fetchData = async (url: string) => {
    const r = await fetch(url, { signal: AbortSignal.timeout(2500), next: { revalidate: 86400 } }).catch(() => null);
    if (!r?.ok || !(r.headers.get("content-type") ?? "").startsWith("image/")) return null;
    return `data:${r.headers.get("content-type")};base64,${Buffer.from(await r.arrayBuffer()).toString("base64")}`;
  };
  if (isCardKind(kind)) return fetchData(CARD_LOGO);
  const t = ticker?.toUpperCase();
  if (!t || !/^[A-Z0-9.]{1,12}$/.test(t)) return null;
  if (CACHED[t]) {
    const png = await readFile(join(process.cwd(), "public/logos", CACHED[t])).catch(() => null);
    if (png) return `data:image/png;base64,${png.toString("base64")}`;
  }
  if (kind.toLowerCase().startsWith("pre")) return null;
  return fetchData(`https://financialmodelingprep.com/image-stock/${t}.png`);
}

/** Cash, predictions and metals get a glyph, as in the app. */
function glyph(leg: Leg, ticker: string | null): { text: string; tint: string } | null {
  const k = leg.kind.toLowerCase();
  if (k.startsWith("earns") || k === "cash" || leg.name === "Cash") return { text: "$", tint: INK.up };
  if (k.startsWith("prediction")) return { text: "%", tint: "#8C6BF0" };
  if (ticker?.toUpperCase() === "XAU") return { text: "Au", tint: "#DBAD38" };
  if (ticker?.toUpperCase() === "XAG") return { text: "Ag", tint: "#C7C7C7" };
  return null;
}

/** The SVG path of one donut slice, from `a0` to `a1` (fractions of a turn, 0 at 12 o'clock). */
function slice(cx: number, cy: number, r: number, inner: number, a0: number, a1: number): string {
  const pt = (rad: number, a: number) => [cx + rad * Math.sin(a * 2 * Math.PI), cy - rad * Math.cos(a * 2 * Math.PI)];
  const large = a1 - a0 > 0.5 ? 1 : 0;
  const [x0, y0] = pt(r, a0), [x1, y1] = pt(r, a1), [x2, y2] = pt(inner, a1), [x3, y3] = pt(inner, a0);
  return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} L ${x2} ${y2} A ${inner} ${inner} 0 ${large} 0 ${x3} ${y3} Z`;
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [d, fonts] = await Promise.all([getDraft(id), ogFonts()]);
  if (!d) return new Response("Not found", { status: 404 });
  const legs = basketFrom({ verdict: "basket", summary: d.summary, legs: d.legs }).legs.slice(0, 5);
  const tickers = await assetKeys(legs.map((l) => l.assetId ?? "")).catch(() => ({} as Record<string, string>));
  const rows = await Promise.all(legs.map(async (l) => {
    const ticker = (l.assetId && tickers[l.assetId]) || null;
    const g = glyph(l, ticker);
    return { leg: l, color: SERIES[l.slot % SERIES.length], glyph: g, logo: g ? null : await logoData(ticker, l.kind) };
  }));

  const total = legs.reduce((s, l) => s + l.weight, 0) || 1;
  const C = 230, R = 210, IN = 128;
  let at = 0;
  const paths = rows.map((r) => {
    const a0 = at;
    at += r.leg.weight / total;
    // A single pick is a whole ring (an arc can't start and end at the same point).
    const a1 = rows.length === 1 ? 0.9999 : at;
    return { d: slice(C, C, R, IN, a0, a1), color: r.color };
  });
  const claim = d.claim.length > 90 ? `${d.claim.slice(0, 87)}...` : d.claim;
  const logoSize = rows.length > 4 ? 52 : 60;

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", padding: "48px 64px", background: INK.bg, color: INK.text, fontFamily: "Geist" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 26, color: INK.muted }}>
          <span>{`${d.risk[0].toUpperCase()}${d.risk.slice(1)} risk · ${legs.length} ${legs.length === 1 ? "pick" : "picks"}`}</span>
          <span style={{ fontFamily: "Geist", fontWeight: 600, color: INK.text }}>thesis</span>
        </div>
        <div style={{ display: "flex", marginTop: 18, fontFamily: "Geist Serif", fontSize: claim.length > 60 ? 44 : 54, lineHeight: 1.12 }}>{claim}</div>
        <div style={{ display: "flex", flex: 1, alignItems: "center", gap: 56, marginTop: 12 }}>
          <svg width={C * 2} height={C * 2} viewBox={`0 0 ${C * 2} ${C * 2}`} style={{ flexShrink: 0, width: 380, height: 380 }}>
            {paths.map((p, i) => <path key={i} d={p.d} fill={p.color} stroke={INK.bg} strokeWidth={rows.length === 1 ? 0 : 6} />)}
          </svg>
          <div style={{ display: "flex", flexDirection: "column", gap: rows.length > 4 ? 14 : 20, flex: 1 }}>
            {rows.map((r) => (
              <div key={r.leg.slot} style={{ display: "flex", alignItems: "center", gap: 22 }}>
                <div style={{ width: 14, height: logoSize, borderRadius: 7, background: r.color, display: "flex" }} />
                {r.logo ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={r.logo} width={logoSize} height={logoSize} style={{ borderRadius: 14, background: "#FFFFFF", objectFit: "contain" }} />
                ) : (
                  <div style={{ width: logoSize, height: logoSize, borderRadius: 14, background: r.glyph ? "#1A1D24" : r.color, color: r.glyph?.tint ?? "#FFFFFF", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28, fontWeight: 600 }}>
                    {r.glyph?.text ?? r.leg.name.slice(0, 1).toUpperCase()}
                  </div>
                )}
                <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
                  <span style={{ fontSize: 32, fontWeight: 600 }}>{r.leg.name.length > 26 ? `${r.leg.name.slice(0, 25)}…` : r.leg.name}</span>
                  <span style={{ fontSize: 22, color: INK.muted }}>{r.leg.kind}</span>
                </div>
                <span style={{ fontFamily: "Geist Mono", fontSize: 36, color: INK.text }}>{`${Math.round(r.leg.weight)}%`}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    ),
    { width: W, height: H, fonts, headers: ogCache(300) },
  );
}
