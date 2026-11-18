"use client";
// Copy from X, like the iOS XCopyView: add an X account, and each market call it posts becomes a
// drafted take. The accounts you copy sit in a row of faces (tap one for just its calls), then
// every call, newest first. Nothing trades by itself (one-tap copy, not auto-copy).
// Copy on a call opens the composer with that take drafted, its basket built, credited to the post.
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { age } from "@/components/TakeRow";
import { XAvatar, type XAccount } from "@/components/XTraders";
import { useComposer } from "@/components/Composer";
import { fromCall } from "@/lib/compose";
import { useSession } from "@/lib/session";


/** Market accounts to start with when you copy nobody yet (the app's list). */
const SUGGESTIONS = ["KobeissiLetter", "unusual_whales", "zerohedge", "WatcherGuru"];

/** "@KobeissiLetter" or a profile link → "KobeissiLetter". */
function cleanHandle(s: string): string {
  let h = s.trim();
  const m = h.match(/(?:x|twitter)\.com\/(.+)/i);
  if (m) h = m[1];
  h = h.replace(/@/g, "");
  return (h.match(/^[A-Za-z0-9_]+/)?.[0] ?? "").slice(0, 15);
}

export default function XCopyPage() {
  const router = useRouter();
  const { source } = useSession();
  const composer = useComposer();
  const [accounts, setAccounts] = useState<XAccount[] | null>(null);
  const [handle, setHandle] = useState("");
  const [adding, setAdding] = useState(false);
  const [copying, setCopying] = useState<string | null>(null);
  const [only, setOnly] = useState<string | null>(null);
  const [menu, setMenu] = useState<XAccount | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    source<{ accounts: XAccount[] }>("GET", "x").then((r) => setAccounts(r.accounts)).catch(() => setAccounts((a) => a ?? []));
  }, [source]);
  useEffect(load, [load]);

  async function copy(raw: string) {
    const h = cleanHandle(raw);
    if (!h || copying) return;
    setError(null);
    setCopying(h);
    try {
      // The first person to copy an account waits while its recent posts are read (several seconds).
      const r = await source<{ account: XAccount }>("PUT", `x/${h}`);
      setAccounts((a) => [r.account, ...(a ?? []).filter((x) => x.handle !== r.account.handle)]);
      setHandle("");
      setAdding(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCopying(null);
    }
  }

  async function stop(a: XAccount) {
    setMenu(null);
    if (only === a.handle) setOnly(null);
    const before = accounts;
    setAccounts((list) => (list ?? []).filter((x) => x.handle !== a.handle));
    try {
      await source("DELETE", `x/${a.handle}`);
    } catch {
      setAccounts(before);
    }
  }

  const list = accounts ?? [];
  const calls = list
    .filter((a) => only == null || a.handle === only)
    .flatMap((a) => a.calls.map((c) => ({ a, c })))
    .sort((x, y) => y.c.posted_at.localeCompare(x.c.posted_at));

  return (
    <main className="page xcopy">
      <button className="nav-back" onClick={() => router.back()}>‹ Back</button>
      <h1 className="title">Copy from X</h1>
      <p className="muted small">Their market calls become takes. Tap one to build the basket; buying in is up to you.</p>

      <div className="xfaces">
        <button className="xface" onClick={() => setAdding((v) => !v)} aria-label={adding ? "Close" : "Copy an account"}>
          <span className="xadd">{adding ? "×" : "+"}</span>
          <span className="muted small">{adding ? "Close" : "Add"}</span>
        </button>
        {list.map((a) => {
          const on = only === a.handle;
          return (
            <button key={a.handle} className="xface" style={{ opacity: only == null || on ? 1 : 0.45 }} onClick={() => setOnly(on ? null : a.handle)}
              onContextMenu={(e) => { e.preventDefault(); setMenu(a); }} aria-pressed={on} aria-label={`@${a.username}`}>
              <span className={`xring${on ? " on" : ""}`}><XAvatar account={a} size={54} /></span>
              <span className="small" style={{ fontWeight: on ? 600 : 400, color: on ? "var(--text)" : "var(--muted)" }}>{a.username}</span>
            </button>
          );
        })}
      </div>
      {only ? (
        <div className="xonly small">
          Showing @{list.find((a) => a.handle === only)?.username}
          <button className="up" onClick={() => setMenu(list.find((a) => a.handle === only) ?? null)}>More</button>
        </div>
      ) : null}

      {adding || (accounts != null && list.length === 0) ? (
        <form className="xadd-row" onSubmit={(e) => { e.preventDefault(); copy(handle); }}>
          <span className="muted">@</span>
          <input placeholder="Handle or profile link" value={handle} onChange={(e) => setHandle(e.target.value)} autoCapitalize="none" autoCorrect="off" spellCheck={false} aria-label="X handle" enterKeyHint="go" />
          {cleanHandle(handle) ? <button type="submit" className="up" disabled={!!copying} style={{ fontWeight: 600 }}>Copy</button> : null}
        </form>
      ) : null}
      {copying ? <p className="muted small">Reading @{copying}&apos;s recent posts…</p> : null}
      {error ? <p className="err">{error}</p> : null}

      <div className="hair" />
      {accounts == null ? <p className="muted search-empty">Loading…</p> : null}
      {accounts != null && list.length === 0 && !copying ? (
        <section>
          <h2 className="search-h">Start with</h2>
          {SUGGESTIONS.map((s) => (
            <button key={s} className="xsuggest" onClick={() => copy(s)} disabled={!!copying}>
              <span>@{s}</span><span className="up">+</span>
            </button>
          ))}
        </section>
      ) : null}
      {list.length > 0 && calls.length === 0 ? (
        <p className="muted search-empty">{only == null ? "No market calls yet. You'll hear when they make one." : "No market calls from them in the last three weeks."}</p>
      ) : null}

      {calls.map(({ a, c }) => {
        const name = a.name ?? a.username;
        return (
          <article key={c.post_id} className="xcall">
            <XAvatar account={a} size={36} />
            <div className="xcall-main">
              <div className="small">
                <b>{name}</b>{" "}
                <span className="muted">{name.toLowerCase() === a.username.toLowerCase() ? "" : `@${a.username} · `}{age(c.posted_at)}</span>
              </div>
              <div className="xcall-claim">{c.claim}</div>
              {/^https?:\/\//.test(c.url) ? (
                <a className="xcall-post muted small" href={c.url} target="_blank" rel="noopener noreferrer nofollow">{c.text}</a>
              ) : <div className="xcall-post muted small">{c.text}</div>}
              <div className="xcall-foot">
                <span className="mono muted" style={{ fontSize: 11 }}>{c.risk ? `${c.risk[0].toUpperCase()}${c.risk.slice(1)} risk` : ""}</span>
                <button className="up small" style={{ fontWeight: 600 }} onClick={() => composer.open(fromCall({ ...c, label: `@${a.username} on X` }))} aria-label="Copy this call">Copy →</button>
              </div>
            </div>
          </article>
        );
      })}

      {menu ? (
        <div className="sheet-wrap" onClick={(e) => e.target === e.currentTarget && setMenu(null)}>
          <div className="sheet" role="dialog" aria-label={`@${menu.username}`}>
            <h3>@{menu.username}</h3>
            <a className="obtn" style={{ marginTop: 12 }} href={`https://x.com/${menu.username}`} target="_blank" rel="noopener noreferrer nofollow">Open on X ↗</a>
            <button className="obtn plain down" onClick={() => stop(menu)}>Stop copying</button>
          </div>
        </div>
      ) : null}
    </main>
  );
}
