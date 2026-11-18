import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import Avatar from "@/components/Avatar";
import Basket from "@/components/Basket";
import Comments from "@/components/Comments";
import TradeDock from "@/components/TradeDock";
import { authorName, calledIt, getReceipt, getTake, HORIZON, isDeleted, pct, takeReturn } from "@/lib/data";

export const revalidate = 15;

// No pages at build time; each one renders on its first visit and is then cached and refreshed
// every `revalidate` seconds (ISR). Next 16 needs this export for `revalidate` to apply to a
// dynamic segment (docs: generate-static-params, "All paths at runtime").
export function generateStaticParams() {
  return [];
}

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const take = await getTake(id);
  if (!take) return { title: "Thesis" };
  const who = authorName(take.author);
  const description = `${who}'s take on Thesis. Trade it or fade it.`;
  return {
    title: `${take.claim} · Thesis`,
    description,
    openGraph: { title: take.claim, description, type: "article", url: `/t/${id}` },
    twitter: { card: "summary_large_image", title: take.claim, description },
  };
}

export default async function TakePage({ params }: Props) {
  const { id } = await params;
  const [take, receipt] = await Promise.all([getTake(id), getReceipt(id)]);
  if (!take) notFound();

  const ret = takeReturn(take, receipt);
  const settles = take.settles_at ? new Date(take.settles_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null;

  return (
    <main className="page">
      <div className="top">
        <Link href="/" className="brand">thesis</Link>
      </div>

      {isDeleted(take.author) ? (
        // A deleted account: no handle and no profile to open.
        <div className="author">
          <Avatar person={take.author} />
          <div style={{ fontWeight: 600 }}>{authorName(take.author)}</div>
        </div>
      ) : (
        <Link className="author author-link" href={`/u/${take.author.handle}`}>
          <Avatar person={take.author} />
          <div>
            <div style={{ fontWeight: 600 }}>{authorName(take.author)}</div>
            <div className="muted small">@{take.author.handle}</div>
          </div>
        </Link>
      )}

      <h1 className="claim">{take.claim}</h1>
      <div className="caps">
        {take.risk} risk · {HORIZON[take.horizon] ?? take.horizon}
        {settles ? ` · settles ${settles}` : ""}
      </div>
      {take.source && /^https?:\/\//.test(take.source.url) ? (
        <a className="via" href={take.source.url} target="_blank" rel="noopener noreferrer nofollow">
          via {take.source.label} ↗
        </a>
      ) : null}

      <div className={`big ${ret >= 0 ? "up" : "down"}`}>{pct(ret)}</div>
      <div className="caps">{receipt?.onChain ? "on-chain · since posted" : "since posted"}</div>
      {calledIt(ret) ? (
        <div className="tags">
          <Link className="tag tag-up" href={`/c/${take.id}`}>✓ Called it · share ↗</Link>
        </div>
      ) : null}

      <div className="section">
        <h2>Basket <span className="caps">weight</span></h2>
        <Basket legs={take.legs} receipt={receipt?.legs} />
      </div>

      <TradeDock takeId={take.id} author={authorName(take.author)} receipt={receipt} />

      <Comments takeId={take.id} author={authorName(take.author)} claim={take.claim} initialCount={take.comments} />
    </main>
  );
}
