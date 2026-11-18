// The link preview for a shared take (iMessage, X, Slack…): the claim, who said it, the basket and
// the return, in the app's look.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { authorName, getReceipt, getTake, isDeleted, pct, SERIES, stateShort, takeState } from "@/lib/data";
import { ogCache } from "@/lib/og";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "A take on Thesis";
export const revalidate = 60;

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [take, receipt, serif, sans] = await Promise.all([
    getTake(id),
    getReceipt(id),
    readFile(join(process.cwd(), "app/fonts/GeistSerif-Regular.ttf")),
    readFile(join(process.cwd(), "app/fonts/Geist-Medium.ttf")),
  ]);
  const claim = take?.claim ?? "A take on Thesis";
  const ret = receipt?.onChain && receipt.returnBps != null ? receipt.returnBps / 100 : take?.ret ?? 0;
  const who = !take ? "" : isDeleted(take.author) ? authorName(take.author) : `${authorName(take.author)} · @${take.author.handle}`;
  const legs = take?.legs ?? [];
  // The return is shown big; beside it, whether it's still open or closed (and when).
  const status = stateShort(takeState(take, receipt));
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 64, background: "#07080B", color: "#F2F3F5", fontFamily: "Geist" }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 28, color: "#9AA0AA" }}>
          <span>{who}</span>
          <span>thesis</span>
        </div>
        <div style={{ display: "flex", fontFamily: "GeistSerif", fontSize: claim.length > 70 ? 56 : 72, lineHeight: 1.1 }}>{claim}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 24 }}>
            <span style={{ fontSize: 64, color: ret >= 0 ? "#A6E3B8" : "#F2A9C2" }}>{pct(ret)}</span>
            <span style={{ fontSize: 28, color: "#9AA0AA" }}>
              {take ? `${take.risk} risk · ${status} · ${take.backs} traded · ${take.fades} faded` : ""}
            </span>
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
