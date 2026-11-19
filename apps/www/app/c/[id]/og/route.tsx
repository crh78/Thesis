// The called-it card's link preview in the theme the sharer picked: /c/<id>/og?theme=gold.
import { ImageResponse } from "next/og";
import { asHolder, cardData, themeOf } from "@/lib/called";
import { getHolder, getReceipt, getTake } from "@/lib/data";
import { OG_SIZE, ogAvatar, ogFonts } from "@/lib/og";
import { CalledOg } from "@/lib/og-called";

export const revalidate = 60;

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const q = new URL(req.url).searchParams;
  const theme = themeOf(q.get("theme"));
  const by = q.get("by");
  const [take, receipt, fonts] = await Promise.all([getTake(id), getReceipt(id), ogFonts()]);
  if (!take) return new Response("Not found", { status: 404 });
  // A holder's P&L card (?by=&side=): their face and return, from their position.
  const h = by ? await getHolder(id, by, q.get("side") === "fade" ? "fade" : "back") : null;
  const d = h ? asHolder(cardData(take, receipt), h) : cardData(take, receipt);
  const a = await ogAvatar(h ? h.person : take.author);
  return new ImageResponse(<CalledOg theme={theme} d={d} a={a} />, {
    ...OG_SIZE,
    fonts,
    headers: { "cache-control": "public, max-age=60, s-maxage=60, stale-while-revalidate=600" },
  });
}
