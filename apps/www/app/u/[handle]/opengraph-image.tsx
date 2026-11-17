import { ImageResponse } from "next/og";
import { calledIt, getProfile, getProfileTakes, nameOf, pct } from "@/lib/data";
import { Check, INK, OG_SIZE, OgAvatar, ogAvatar, ogFonts } from "@/lib/og";

export const size = OG_SIZE;
export const contentType = "image/png";
export const revalidate = 60;
export const alt = "A profile on Thesis";

export default async function Image({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params;
  const [p, fonts] = await Promise.all([getProfile(handle), ogFonts()]);
  if (!p) return new ImageResponse(<div style={{ width: "100%", height: "100%", background: INK.bg }} />, { ...size, fonts });

  const takes = await getProfileTakes(p.id);
  const called = takes.filter((t) => calledIt(t.ret));
  const best = [...called].sort((a, b) => b.ret - a.ret)[0];
  const a = await ogAvatar(p);
  const stat = (label: string, value: string, color: string = INK.text) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontFamily: "Geist Mono", fontSize: 22, letterSpacing: 1, textTransform: "uppercase", color: INK.muted }}>{label}</span>
      <span style={{ fontFamily: "Geist Mono", fontSize: 54, color }}>{value}</span>
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

      <div style={{ display: "flex", gap: 72, borderTop: `1px solid ${INK.hairline}`, paddingTop: 28 }}>
        {stat("Called it", String(called.length), called.length ? INK.up : INK.text)}
        {stat("Takes", String(takes.length))}
        {best ? stat("Best call", pct(best.ret), INK.up) : null}
      </div>
    </div>
    ),
    { ...size, fonts },
  );
}
