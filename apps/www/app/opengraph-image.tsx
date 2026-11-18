// The homepage's link preview (the X bot's bio link, and any page without a preview of its own):
// the wordmark and what Thesis does, in the app's look. Drawn once at build time.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { SERIES } from "@/lib/data";
import { INK, OG_SIZE, ogFonts } from "@/lib/og";

export const size = OG_SIZE;
export const contentType = "image/png";
export const alt = "Thesis: say a take, friends trade it or fade it, and the chain keeps score.";

export default async function Image() {
  const [fonts, pixel] = await Promise.all([ogFonts(), readFile(join(process.cwd(), "app/fonts/GeistPixel-Square.ttf"))]);
  const weights = [30, 25, 20, 15, 10];
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 72, background: INK.bg, color: INK.text, fontFamily: "Geist", backgroundImage: "radial-gradient(ellipse 900px 500px at 50% 0%, rgba(130,150,255,0.2), transparent)" }}>
        <span style={{ fontFamily: "Geist Pixel", fontSize: 64, lineHeight: 1 }}>thesis</span>
        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          <span style={{ fontFamily: "Geist Serif", fontSize: 88, lineHeight: 1.05, letterSpacing: -1 }}>Say a take.</span>
          <span style={{ fontSize: 40, lineHeight: 1.25, color: INK.muted, maxWidth: 980 }}>Friends trade it or fade it, and the chain keeps score.</span>
        </div>
        <div style={{ display: "flex", gap: 8, height: 14 }}>
          {weights.map((w, i) => (
            <div key={i} style={{ flex: w, background: SERIES[i], borderRadius: 7 }} />
          ))}
        </div>
      </div>
    ),
    { ...size, fonts: [...fonts, { name: "Geist Pixel", data: pixel, weight: 400 as const, style: "normal" as const }] },
  );
}
