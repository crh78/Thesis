// The called-it card's link preview in the theme the sharer picked: /c/<id>/og?theme=gold.
import { ImageResponse } from "next/og";
import { cardData, themeOf } from "@/lib/called";
import { getReceipt, getTake } from "@/lib/data";
import { OG_SIZE, ogAvatar, ogFonts } from "@/lib/og";
import { CalledOg } from "@/lib/og-called";

export const revalidate = 60;

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const theme = themeOf(new URL(req.url).searchParams.get("theme"));
  const [take, receipt, fonts] = await Promise.all([getTake(id), getReceipt(id), ogFonts()]);
  if (!take) return new Response("Not found", { status: 404 });
  const d = cardData(take, receipt);
  const a = await ogAvatar(take.author);
  return new ImageResponse(<CalledOg theme={theme} d={d} a={a} />, {
    ...OG_SIZE,
    fonts,
    headers: { "cache-control": "public, max-age=60, s-maxage=60, stale-while-revalidate=600" },
  });
}
