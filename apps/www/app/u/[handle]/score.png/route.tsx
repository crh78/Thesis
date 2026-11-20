// A person's score as a picture, for the X bot's "score" reply: who they are, their two scores
// (own P&L and made for backers, as the profile shows them), how many takes and calls, and their
// portfolio's P&L line over all its history (the fork API's chart, so deposits don't move it).
// Drawn from the app's own data, never by a model.
import { ImageResponse } from "next/og";
import { calledIt, getPortfolioHistory, getProfile, getProfileTakes, getProfileWallet, money, nameOf, pct } from "@/lib/data";
import { INK, OgAvatar, ogAvatar, ogCache, ogFonts } from "@/lib/og";

export const revalidate = 300;

const W = 1200;
const H = 675;

/**
 * Short spikes out: a snapshot taken mid-trade can catch the cash gone and the picks not yet
 * counted. A run of up to 3 points more than 1.5% off the points on either side, which agree within
 * 1%, takes their average.
 */
export function despike(input: { at: number; value: number }[]) {
  const points = input.map((p) => ({ ...p }));
  for (let len = 1; len <= 3; len++) {
    for (let i = 1; i + len < points.length; i++) {
      const a = points[i - 1].value, b = points[i + len].value;
      if (a <= 0 || b <= 0 || Math.abs(a - b) / Math.max(a, b) >= 0.01) continue;
      const run = points.slice(i, i + len);
      if (run.every((p) => Math.abs(p.value - a) / a > 0.015 && Math.abs(p.value - b) / b > 0.015)) {
        for (const p of run) p.value = (a + b) / 2;
      }
    }
  }
  return points;
}

/** The P&L line as an SVG path, scaled into w × h; at least 5% of the value tall, so small moves stay small. */
function line(raw: { at: number; value: number }[], w: number, h: number): { d: string; area: string } | null {
  if (raw.length < 2) return null;
  const points = despike(raw);
  const t0 = points[0].at, t1 = points[points.length - 1].at;
  const vs = points.map((p) => p.value);
  let lo = Math.min(...vs), hi = Math.max(...vs);
  const mid = (lo + hi) / 2;
  const span = Math.max(hi - lo, Math.abs(mid) * 0.05, 2);
  lo = mid - span / 2;
  hi = mid + span / 2;
  const x = (t: number) => (t1 > t0 ? ((t - t0) / (t1 - t0)) * w : 0);
  const y = (v: number) => h - ((v - lo) / (hi - lo)) * (h - 8) - 4;
  const d = points.map((p, i) => `${i ? "L" : "M"} ${x(p.at).toFixed(1)} ${y(p.value).toFixed(1)}`).join(" ");
  return { d, area: `${d} L ${w} ${h} L 0 ${h} Z` };
}

export async function GET(_req: Request, { params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const [p, fonts] = await Promise.all([getProfile(handle), ogFonts()]);
  if (!p) return new Response("Not found", { status: 404 });
  const [takes, wallet, a] = await Promise.all([getProfileTakes(p.id), getProfileWallet(p.id), ogAvatar(p)]);
  const history = wallet ? await getPortfolioHistory(wallet) : null;
  const called = takes.filter((t) => calledIt(t.ret));
  const best = [...takes].sort((x, y) => y.ret - x.ret)[0];
  const made = p.made ?? 0;
  const backers = p.backers_made ?? 0;
  const dollars = (x: number) => money(Math.round(x), true).replace(/\.00$/, "");
  const CW = 1072, CH = 170;
  const chart = history ? line(history.points, CW, CH) : null;
  const up = (history?.change ?? 0) >= 0;
  const color = up ? INK.up : INK.down;

  const stat = (label: string, value: string, tint: string, sub?: string) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontFamily: "Geist Mono", fontSize: 18, letterSpacing: 1, textTransform: "uppercase", color: INK.muted }}>{label}</span>
      <span style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <span style={{ fontFamily: "Geist Mono", fontSize: 38, color: tint }}>{value}</span>
        {sub ? <span style={{ fontFamily: "Geist Mono", fontSize: 22, color: INK.muted }}>{sub}</span> : null}
      </span>
    </div>
  );

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", padding: "44px 64px", background: INK.bg, color: INK.text, fontFamily: "Geist", backgroundImage: "radial-gradient(ellipse 900px 500px at 50% 0%, rgba(130,150,255,0.16), transparent)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 24 }}>
          <OgAvatar a={a} size={96} letter={(p.handle ?? "?").slice(0, 1).toUpperCase()} />
          <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
            <span style={{ fontSize: 48, fontWeight: 600, letterSpacing: -1, lineHeight: 1.05 }}>{nameOf(p)}</span>
            {p.handle ? <span style={{ fontSize: 26, color: INK.muted }}>{`@${p.handle} · ${p.takes ?? takes.length} takes`}</span> : null}
          </div>
          <span style={{ fontFamily: "Geist Mono", fontSize: 30, letterSpacing: -1 }}>thesis</span>
        </div>

        <div style={{ display: "flex", gap: 56, marginTop: 28 }}>
          {stat("Own P&L", dollars(made), made < 0 ? INK.down : INK.up, pct(p.return_pct ?? 0))}
          {stat("Made for backers", dollars(backers), backers < 0 ? INK.down : INK.up, pct(p.backers_pct ?? 0))}
          {stat("Called it", String(called.length), called.length ? INK.up : INK.text)}
        </div>

        <div style={{ display: "flex", flexDirection: "column", marginTop: 24, flex: 1, justifyContent: "flex-end" }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 20, color: INK.muted, marginBottom: 8 }}>
            <span style={{ fontFamily: "Geist Mono", letterSpacing: 1, textTransform: "uppercase" }}>Portfolio</span>
            {history ? <span style={{ fontFamily: "Geist Mono", color }}>{`${dollars(history.change)} · ${pct(history.changePct)} all time`}</span> : null}
          </div>
          {chart ? (
            <svg width={CW} height={CH} viewBox={`0 0 ${CW} ${CH}`} style={{ width: CW, height: CH }}>
              <path d={chart.area} fill={up ? "rgba(166,227,184,0.12)" : "rgba(242,169,194,0.12)"} />
              <path d={chart.d} fill="none" stroke={color} strokeWidth={4} strokeLinejoin="round" strokeLinecap="round" />
            </svg>
          ) : (
            <div style={{ display: "flex", height: CH, alignItems: "center", justifyContent: "center", color: INK.muted, fontSize: 24, border: `1px solid ${INK.hairline}`, borderRadius: 16 }}>No trades yet</div>
          )}
          {best ? (
            <span style={{ fontSize: 22, color: INK.muted, marginTop: 14 }}>
              {`Best take: ${best.claim.length > 60 ? `${best.claim.slice(0, 58)}…` : best.claim}  ${pct(best.ret)}`}
            </span>
          ) : null}
        </div>
      </div>
    ),
    { width: W, height: H, fonts, headers: ogCache(revalidate) },
  );
}
