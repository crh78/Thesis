"use client";
// A take's comments, like the iOS CommentsView: Top / Newest, replies one level deep, likes, and a
// compose bar ("Add a comment…", or a reply). Reading is public; commenting needs an account.
import { useCallback, useEffect, useState } from "react";
import { rpcNow, type Person } from "@/lib/data";
import { useSession } from "@/lib/session";
import Avatar from "./Avatar";
import SignIn from "./SignIn";
import { age } from "./TakeRow";

type Comment = { id: string; author: Person; body: string; created_at: string; likes: number; liked: boolean; replies?: Comment[] | null };

/** "Comments · 3" on a take page; opens the thread. `?comments=1` (from the feed) opens it on load. */
export default function Comments({ takeId, author, claim, initialCount }: { takeId: string; author: string; claim: string; initialCount: number }) {
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(initialCount);
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("comments") === "1") {
      window.history.replaceState(null, "", window.location.pathname);
      setOpen(true);
    }
  }, []);
  return (
    <>
      <div className="section">
        <button className="comments-open" onClick={() => setOpen(true)}>
          <h2 style={{ margin: 0 }}>Comments <span className="muted mono" style={{ fontWeight: 400 }}>· {count}</span></h2>
          <span className="muted">Say what you think ›</span>
        </button>
      </div>
      {open ? <Thread takeId={takeId} author={author} claim={claim} onClose={() => setOpen(false)} onCount={setCount} /> : null}
    </>
  );
}

function Thread({ takeId, author, claim, onClose, onCount }: { takeId: string; author: string; claim: string; onClose: () => void; onCount: (n: number) => void }) {
  const { phase, snapshot, social } = useSession();
  const me = snapshot?.profile;
  const signedIn = phase.kind === "ready";
  const [comments, setComments] = useState<Comment[] | null>(null);
  const [sort, setSort] = useState<"top" | "newest">("top");
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<Comment | null>(null);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = useCallback((list: Comment[]) => {
    setComments(list);
    onCount(list.reduce((n, c) => n + 1 + (c.replies?.length ?? 0), 0));
  }, [onCount]);

  const load = useCallback(() => {
    rpcNow<Comment[]>("take_comments", { p_take: takeId, p_viewer: me?.id ?? null })
      .then(apply)
      .catch((e) => { setComments((c) => c ?? []); setError(e instanceof Error ? e.message : String(e)); });
  }, [takeId, me?.id, apply]);
  useEffect(load, [load]);

  async function post() {
    const text = draft.trim();
    if (!text) return;
    setPosting(true);
    setError(null);
    try {
      const r = await social<{ comments: Comment[] }>("POST", "comments", { take_id: takeId, parent_id: replyTo?.id ?? null, body: text });
      apply(r.comments);
      setDraft("");
      setReplyTo(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't post. Try again.");
    } finally {
      setPosting(false);
    }
  }

  async function like(c: Comment) {
    if (!signedIn) return;
    const on = !c.liked;
    const flip = (list: Comment[]): Comment[] => list.map((x) => (x.id === c.id ? { ...x, liked: on, likes: x.likes + (on ? 1 : -1) } : { ...x, replies: x.replies ? flip(x.replies) : x.replies }));
    setComments((l) => (l ? flip(l) : l));
    try {
      await social(on ? "PUT" : "DELETE", `comments/${c.id}/like`);
    } catch {
      load();
    }
  }

  const sorted = [...(comments ?? [])].sort((a, b) => (sort === "top" ? b.likes - a.likes : b.created_at.localeCompare(a.created_at)));
  const total = (comments ?? []).reduce((n, c) => n + 1 + (c.replies?.length ?? 0), 0);

  return (
    <div className="sheet-wrap" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet comments-sheet" role="dialog" aria-label="Comments">
        <button className="x" aria-label="Close" onClick={onClose}>×</button>
        <h3>Comments{comments ? ` · ${total}` : ""}</h3>
        <p className="muted small comments-on">On {author}&apos;s take · {claim}</p>
        <div className="segmented" style={{ gridTemplateColumns: "1fr 1fr" }} role="tablist">
          <button role="tab" aria-selected={sort === "top"} className={sort === "top" ? "on" : ""} onClick={() => setSort("top")}>Top</button>
          <button role="tab" aria-selected={sort === "newest"} className={sort === "newest" ? "on" : ""} onClick={() => setSort("newest")}>Newest</button>
        </div>

        <div className="comments-list">
          {comments == null ? <p className="muted search-empty">Loading…</p> : null}
          {comments?.length === 0 ? <p className="muted search-empty">No comments yet. Say what you think.</p> : null}
          {sorted.map((c) => (
            <div key={c.id}>
              <CommentRow c={c} onLike={like} onReply={signedIn ? () => setReplyTo(c) : undefined} canLike={signedIn} />
              {(c.replies ?? []).map((r) => (
                <div key={r.id} className="reply"><CommentRow c={r} small onLike={like} onReply={signedIn ? () => setReplyTo(c) : undefined} canLike={signedIn} /></div>
              ))}
            </div>
          ))}
        </div>

        {error ? <div className="err">{error}</div> : null}
        {signedIn ? (
          <div className="compose">
            {replyTo ? (
              <div className="replying muted small">
                Replying to {replyTo.author.id === me?.id ? "yourself" : (replyTo.author.display_name ?? replyTo.author.handle)}
                <button aria-label="Cancel reply" onClick={() => setReplyTo(null)}>×</button>
              </div>
            ) : null}
            <div className="compose-bar">
              <textarea rows={1} maxLength={500} placeholder={replyTo ? "Add a reply…" : "Add a comment…"} value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Comment" />
              <button className="send" disabled={posting || !draft.trim()} onClick={post} aria-label="Post">
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M12 19V5M5 12l7-7 7 7" /></svg>
              </button>
            </div>
          </div>
        ) : (
          <div style={{ marginTop: 12 }}>
            <p className="muted small">Sign in to comment.</p>
            <SignIn />
          </div>
        )}
      </div>
    </div>
  );
}

function CommentRow({ c, small, onLike, onReply, canLike }: { c: Comment; small?: boolean; onLike: (c: Comment) => void; onReply?: () => void; canLike: boolean }) {
  return (
    <div className="crow">
      <Avatar person={c.author} size={small ? 30 : 36} />
      <div className="crow-main">
        <div className="small"><b>{c.author.display_name ?? c.author.handle}</b> <span className="muted">· {age(c.created_at)}</span></div>
        <div className="crow-body">{c.body}</div>
        <div className="crow-actions small muted">
          <button disabled={!canLike} className={c.liked ? "down" : ""} onClick={() => onLike(c)} aria-pressed={c.liked} aria-label={c.liked ? "Unlike" : "Like"}>
            {c.liked ? "♥" : "♡"} <span className="mono">{c.likes}</span>
          </button>
          {onReply ? <button onClick={onReply}>Reply</button> : null}
        </div>
      </div>
    </div>
  );
}
