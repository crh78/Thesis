// A chat bot's draft take (iMessage or X): the take and the basket Thesis built for it. Nobody owns
// it yet; "Post it" opens it in the composer on that basket, and posting makes it yours. Once
// someone's take from it is live, the link opens that take instead.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import Basket from "@/components/Basket";
import DraftActions from "@/components/DraftActions";
import { basketFrom } from "@/lib/compose";
import { getDraft } from "@/lib/data";

export const revalidate = 10;

// No pages at build time; each one renders on its first visit and is then cached and refreshed
// every `revalidate` seconds (ISR). Next 16 needs this export for `revalidate` to apply to a
// dynamic segment (docs: generate-static-params, "All paths at runtime").
export function generateStaticParams() {
  return [];
}

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const d = await getDraft(id);
  if (!d) return { title: "Thesis" };
  const description = `${d.context ? `${d.context}. ` : ""}A take on Thesis, basket built. Post it and trade it.`;
  return {
    title: `${d.claim} · Thesis`,
    description,
    openGraph: { title: d.claim, description, type: "article", url: `/d/${id}` },
    twitter: { card: "summary_large_image", title: d.claim, description },
  };
}

export default async function DraftPage({ params }: Props) {
  const { id } = await params;
  const d = await getDraft(id);
  if (!d) notFound();
  if (d.take_id) redirect(`/t/${d.take_id}`);

  const { legs } = basketFrom({ verdict: "basket", summary: d.summary, legs: d.legs });

  return (
    <main className="page">
      <div className="top">
        <Link href="/" className="brand">thesis</Link>
      </div>

      <div className="caps">{d.context ?? (d.origin === "x" ? "From X" : "From iMessage")} · not posted yet</div>
      <h1 className="claim">{d.claim}</h1>
      <div className="caps">{d.risk} risk</div>
      {d.source && /^https?:\/\//.test(d.source.url) ? (
        <a className="via" href={d.source.url} target="_blank" rel="noopener noreferrer nofollow">via {d.source.label} ↗</a>
      ) : null}
      {d.summary ? <p className="muted" style={{ marginTop: 16 }}>{d.summary}</p> : null}

      <div className="section">
        <h2>Basket <span className="caps">weight</span></h2>
        <Basket legs={legs} />
      </div>

      <p className="small muted" style={{ marginTop: 20, marginBottom: 96 }}>
        Thesis built this from a chat. Post it and it&apos;s your take: you buy in, friends can trade or fade it, and the result goes on your record. It runs until you sell your buy-in, or a year at most.
      </p>

      <DraftActions draft={d} />
    </main>
  );
}
