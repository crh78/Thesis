// A person's public page: who they are, how their takes are doing, and the ones they called.
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import Avatar from "@/components/Avatar";
import FollowButton from "@/components/FollowButton";
import ShareButton from "@/components/ShareButton";
import { calledIt, getProfile, getProfileTakes, money, nameOf, pct, shortDate, stateShort, takeState } from "@/lib/data";

export const revalidate = 30;

// No pages at build time; each one renders on its first visit and is then cached and refreshed
// every `revalidate` seconds (ISR). Next 16 needs this export for `revalidate` to apply to a
// dynamic segment (docs: generate-static-params, "All paths at runtime").
export function generateStaticParams() {
  return [];
}

type Props = { params: Promise<{ handle: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { handle } = await params;
  const p = await getProfile(handle);
  if (!p) return { title: "Thesis" };
  const title = `${nameOf(p)} (@${p.handle}) on Thesis`;
  const description = p.bio || `${nameOf(p)}'s takes on Thesis. Trade them or fade them.`;
  return {
    title,
    description,
    openGraph: { title, description, type: "profile", url: `/u/${p.handle ?? p.id}` },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function ProfilePage({ params }: Props) {
  const { handle } = await params;
  const p = await getProfile(handle);
  if (!p) notFound();
  const takes = await getProfileTakes(p.id);
  const called = takes.filter((t) => calledIt(t.ret)).sort((a, b) => b.ret - a.ret);
  const rest = takes.filter((t) => !calledIt(t.ret));
  const best = called[0];
  const made = p.made ?? 0;
  const backers = p.backers_made ?? 0;

  return (
    <main className="page">
      <div className="top">
        <Link href="/" className="brand">thesis</Link>
      </div>

      <section className="me">
        <Avatar person={p} size={84} />
        <h1>{nameOf(p)}</h1>
        {p.handle ? <div className="muted">@{p.handle}</div> : null}
        {p.bio ? <p className="bio">{p.bio}</p> : null}
      </section>

      {/* The two scores every account shows (CLAUDE.md "Two scores, no formula"), in $ and %. */}
      <div className="score-pair">
        <div>
          <span className="caps">Own P&amp;L</span>
          <b className={made < 0 ? "down" : "up"}>{money(made, true)}</b>
          <span className="mono small muted">{pct(p.return_pct ?? 0)}</span>
        </div>
        <div>
          <span className="caps">Made for backers</span>
          <b className={backers < 0 ? "down" : "up"}>{money(backers, true)}</b>
          <span className="mono small muted">{pct(p.backers_pct ?? 0)}</span>
        </div>
      </div>

      <div className="stats stats-3 me-stats">
        <div><span className="caps">Called it</span><b className={called.length ? "up" : ""}>{called.length}</b></div>
        <div><span className="caps">Takes</span><b>{takes.length}</b></div>
        <div><span className="caps">Best call</span><b className={best ? "up" : ""}>{best ? pct(best.ret) : "—"}</b></div>
      </div>

      <div className="actions profile-actions" style={{ marginTop: 18 }}>
        <FollowButton profileId={p.id} />
        <ShareButton text={`${nameOf(p)}'s takes on Thesis`} label="Share profile" className="btn ghost" />
      </div>

      {called.length ? (
        <div className="section">
          <h2>Called it <span className="caps">up since posted</span></h2>
          {called.map((t) => (
            <Link className="called-row" key={t.id} href={`/c/${t.id}`}>
              <div>
                <span className="tag tag-up">✓ Called it</span>
                <div className="called-claim">{t.claim}</div>
                <div className="caps">posted {shortDate(t.created_at)}</div>
              </div>
              <b className="up mono">{pct(t.ret)}</b>
            </Link>
          ))}
        </div>
      ) : null}

      <div className="section">
        <h2>{called.length ? "Other takes" : "Takes"} <span className="caps">since posted</span></h2>
        {rest.length === 0 && called.length === 0 ? <p className="muted">No takes yet.</p> : null}
        {rest.map((t) => (
          <Link className="card" key={t.id} href={`/t/${t.id}`}>
            <span className="caps">{t.risk} · {stateShort(takeState(t))} · posted {shortDate(t.created_at)}</span>
            <div className="claim">{t.claim}</div>
            <div className="mono small">
              <span className={t.ret >= 0 ? "up" : "down"}>{pct(t.ret)}</span>
              <span className="muted"> · {t.backs} traded · {t.fades} faded</span>
            </div>
          </Link>
        ))}
      </div>
    </main>
  );
}
