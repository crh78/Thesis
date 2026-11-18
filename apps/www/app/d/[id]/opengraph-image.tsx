// The link preview for a chat bot's draft take (iMessage, X): the claim, where it came from and
// the basket's picks, in the take preview's look.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { basketFrom } from "@/lib/compose";
import { getDraft, HORIZON, SERIES } from "@/lib/data";
import { ogCache } from "@/lib/og";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "A take on Thesis";
export const revalidate = 300;

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [d, serif, sans] = await Promise.all([
    getDraft(id),
    readFile(join(process.cwd(), "app/fonts/GeistSerif-Regular.ttf")),
    readFile(join(process.cwd(), "app/fonts/Geist-Medium.ttf")),
  ]);
  const claim = d?.claim ?? "A take on Thesis";
  const legs = d ? basketFrom({ verdict: "basket", summary: d.summary, legs: d.legs }).legs : [];
  const top = legs.slice(0, 3).map((l) => `${l.name} ${Math.round(l.weight)}%`).join("  ·  ");
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 64, background: "#07080B", color: "#F2F3F5", fontFamily: "Geist" }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 28, color: "#9AA0AA" }}>
          <span>{d?.context ?? "Made in a chat"}</span>
          <span>thesis</span>
        </div>
        <div style={{ display: "flex", fontFamily: "GeistSerif", fontSize: claim.length > 70 ? 56 : 72, lineHeight: 1.1 }}>{claim}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 24 }}>
            <span style={{ fontSize: 30, color: "#F2F3F5" }}>{top}</span>
            <span style={{ fontSize: 28, color: "#A6E3B8" }}>{d ? `${d.risk} risk · ${HORIZON[d.horizon] ?? d.horizon} · tap to post` : ""}</span>
          </div>
          <div style={{ display: "flex", gap: 6, height: 14 }}>
            {legs.map((l) => (
              <div key={l.slot} style={{ flex: l.weight, background: SERIES[l.slot % SERIES.length], borderRadius: 7 }} />
            ))}
          </div>
        </div>
      </div>
    ),
    { ...size, fonts: [{ name: "GeistSerif", data: serif }, { name: "Geist", data: sans }], headers: ogCache(revalidate) },
  );
}
