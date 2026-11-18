import { ImageResponse } from "next/og";
import { calledIt, getProfile, getProfileTakes, money, nameOf, pct } from "@/lib/data";
import { Check, INK, OG_SIZE, OgAvatar, ogAvatar, ogCache, ogFonts } from "@/lib/og";

export const size = OG_SIZE;
export const contentType = "image/png";
export const revalidate = 60;
export const alt = "A profile on Thesis";

export default async function Image({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const [p, fonts] = await Promise.all([getProfile(handle), ogFonts()]);
  if (!p) return new ImageResponse(<div style={{ width: "100%", height: "100%", background: INK.bg }} />, { ...size, fonts, headers: ogCache(revalidate) });

  const takes = await getProfileTakes(p.id);
  const called = takes.filter((t) => calledIt(t.ret));
  const best = [...called].sort((a, b) => b.ret - a.ret)[0];
  const a = await ogAvatar(p);
  const made = p.made ?? 0;
  const backers = p.backers_made ?? 0;
  // Whole dollars, so three stats fit across the card.
  const dollars = (x: number) => money(Math.round(x), true).replace(/\.00$/, "");
  const stat = (label: string, value: string, color: string = INK.text, sub?: string) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontFamily: "Geist Mono", fontSize: 22, letterSpacing: 1, textTransform: "uppercase", color: INK.muted }}>{label}</span>
      <span style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
        <span style={{ fontFamily: "Geist Mono", fontSize: 44, color }}>{value}</span>
        {sub ? <span style={{ fontFamily: "Geist Mono", fontSize: 26, color: INK.muted }}>{sub}</span> : null}
      </span>
    </div>
  );

  return new ImageResponse(
    (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 64, background: INK.bg, color: INK.text, fontFamily: "Geist", backgroundImage: "radial-gradient(ellipse 900px 500px at 50% 0%, rgba(130,150,255,0.18), transparent)" }}>
      <span style={{ fontFamily: "Geist Mono", fontSize: 34, letterSpacing: -1 }}>thesis</span>

      <div style={{ display: "flex", alignItems: "center", gap: 36 }}>
        <OgAvatar a={a} size={168} letter={(p.handle ?? "?").slice(0, 1).toUpperCase()} />
        <div style={{ display: "flex", flexDirection: "column", gap: 4, maxWidth: 820 }}>
          <span style={{ fontSize: 76, fontWeight: 600, letterSpacing: -2, lineHeight: 1.05 }}>{nameOf(p)}</span>
          {p.handle ? <span style={{ fontSize: 36, color: INK.muted }}>@{p.handle}</span> : null}
          {best ? (
            <span style={{ display: "flex", alignItems: "center", fontSize: 28, color: INK.muted, marginTop: 14 }}>
              <Check size={28} color={INK.up} />
              <span style={{ color: INK.up, marginLeft: 6, marginRight: 12 }}>Called it</span>
              {(best.claim.length > 44 ? `${best.claim.slice(0, 42)}…` : best.claim) + ` ${pct(best.ret)}`}
            </span>
          ) : null}
        </div>
      </div>

      {/* The two scores (own P&L, made for backers), as on the profile, then the calls. */}
      <div style={{ display: "flex", gap: 56, borderTop: `1px solid ${INK.hairline}`, paddingTop: 28 }}>
        {stat("Own P&L", dollars(made), made < 0 ? INK.down : INK.up, pct(p.return_pct ?? 0))}
        {stat("Made for backers", dollars(backers), backers < 0 ? INK.down : INK.up, pct(p.backers_pct ?? 0))}
        {stat("Called it", String(called.length), called.length ? INK.up : INK.text)}
      </div>
    </div>
    ),
    { ...size, fonts, headers: ogCache(revalidate) },
  );
}
