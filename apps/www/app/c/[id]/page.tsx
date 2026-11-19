// "Called it": a brag card for a take that's up, in a few looks you swipe through like filters.
// With ?by=<handle>&side=back|fade, a holder's P&L card instead: their face and their own return,
// read from their position on the chain (getHolder), so the link can't claim a number.
import type { Metadata } from "next";
import Link from "next/link";
import TopBar from "@/components/TopBar";
import { notFound } from "next/navigation";
import CalledStudio from "@/components/CalledStudio";
import { asHolder, cardData, themeOf, type CardData } from "@/lib/called";
import { getHolder, getReceipt, getTake, supabaseUrl, type Receipt, type Take } from "@/lib/data";
import "./called.css";

export const revalidate = 15;

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ theme?: string; card?: string; by?: string; side?: string }> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A card picture made in the app (functions/v1/cards), when the link carries one. */
function cardImage(take: string, card: string | undefined): string | null {
  return card && UUID.test(card) && UUID.test(take)
    ? `${supabaseUrl()}/storage/v1/object/public/cards/${take.toLowerCase()}/${card.toLowerCase()}.jpg`
    : null;
}

/** The card's data: the take's, or a holder's P&L when the link names one who holds it. */
async function card(id: string, take: Take, receipt: Receipt | null, by?: string, side?: string): Promise<CardData> {
  const d = cardData(take, receipt);
  const h = by ? await getHolder(id, by, side === "fade" ? "fade" : "back") : null;
  return h ? asHolder(d, h) : d;
}

/** "&by=jake&side=fade" for a holder's card, else "". */
const holderQuery = (d: CardData) => (d.holder && d.handle ? `by=${d.handle}&side=${d.holder.side}` : "");

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const [{ id }, { theme, card: cardId, by, side }] = await Promise.all([params, searchParams]);
  const [take, receipt] = await Promise.all([getTake(id), getReceipt(id)]);
  if (!take) return { title: "Thesis" };
  const picture = cardImage(id, cardId);
  const d = await card(id, take, receipt, by, side);
  const who = d.handle ? `@${d.handle}` : d.name;
  const title = d.holder
    ? `${who} is ${d.pct} on ${d.holder.author && d.holder.author !== d.handle ? `@${d.holder.author}'s take` : "their take"}: ${d.claim}`
    : d.called ? `${who} called it: ${d.claim}` : `${who}: ${d.claim}`;
  const description = `${d.pct} since ${d.posted}. On Thesis.`;
  const t = themeOf(theme);
  // The app's own picture of the card (9:16) when the link has one, else the drawn preview.
  const image = picture
    ? { url: picture, width: 1080, height: 1920, alt: title }
    : { url: `/c/${id}/og?theme=${t}${holderQuery(d) ? `&${holderQuery(d)}` : ""}`, width: 1200, height: 630, alt: title };
  return {
    title,
    description,
    openGraph: {
      title, description, type: "article", images: [image],
      url: picture ? `/c/${id}?card=${cardId}` : `/c/${id}?${[t === "glow" ? "" : `theme=${t}`, holderQuery(d)].filter(Boolean).join("&")}`.replace(/\?$/, ""),
    },
    twitter: { card: "summary_large_image", title, description, images: [image.url] },
  };
}

export default async function CalledItPage({ params, searchParams }: Props) {
  const [{ id }, { theme, card: cardId, by, side }] = await Promise.all([params, searchParams]);
  const [take, receipt] = await Promise.all([getTake(id), getReceipt(id)]);
  if (!take) notFound();
  const d = await card(id, take, receipt, by, side);
  const picture = cardImage(id, cardId);

  // A card someone shared from the app: show that exact picture, then the way in.
  if (picture) {
    return (
      <main className="page studio">
        <TopBar right={d.handle ? <Link href={`/u/${d.handle}`} className="pill small">@{d.handle}</Link> : null} />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="shared-card" src={picture} alt={d.claim} width={1080} height={1920} />
        <div className="actions studio-actions">
          <Link href={`/t/${d.id}`} className="btn back">Trade it</Link>
          <Link href={`/t/${d.id}`} className="btn ghost">See the take</Link>
        </div>
      </main>
    );
  }

  return (
    <main className="page studio">
      <TopBar right={d.handle ? <Link href={`/u/${d.handle}`} className="pill small">@{d.handle}</Link> : null} />
      <CalledStudio d={d} initial={themeOf(theme)} />
    </main>
  );
}
