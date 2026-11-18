"use client";
// Takes still "posting" (yours only), as the iOS PostingBar and AppState.reconcilePosting: after
// about 2 minutes unconfirmed, checked against the fork API first, "Didn't post" with Retry (the
// same buy-in, no edits) or Discard (a hard delete); on-chain but not live yet, "Check again".
// Me shows each one as a row; at launch, a sheet lists the ones that didn't post.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { money, topicImage, type Take } from "@/lib/data";
import { fork, useForkWallet } from "@/lib/fork";
import { isOnChain, POSTING_STALE_MS, postingBuyIns, sendBuyIn, showMyTakes, waitUntilLive } from "@/lib/posting";
import { useSession } from "@/lib/session";

type State =
  | { kind: "posting" }
  | { kind: "failed"; message: string }
  | { kind: "unconfirmed" }
  | { kind: "working"; text: string }
  | { kind: "confirmDiscard" };

const DIDNT = "Your buy-in didn't go through.";
const age = (t: Take) => Date.now() - new Date(t.created_at).getTime();

/**
 * One posting take. Young ones (under ~2 minutes) say "Posting…" and check themselves once they're
 * old enough; `failed` starts on "Didn't post" (the launch check already asked the fork API).
 * `onChanged` reloads the list (it went live or was discarded).
 */
export function PostingRow({ take, failed, onChanged }: { take: Take; failed?: boolean; onChanged: () => void }) {
  const { social } = useSession();
  const { address, wallet, signAndSubmit } = useForkWallet();
  const [state, setState] = useState<State>(failed ? { kind: "failed", message: DIDNT } : { kind: "posting" });
  const [minStake, setMinStake] = useState(10);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const set = (s: State) => { if (mounted.current) setState(s); };
  const buyIn = postingBuyIns.get(take.id) ?? minStake;

  // On-chain already: wait for it to go live. Otherwise it didn't post.
  async function check() {
    if (await isOnChain(take.id)) return wait();
    set({ kind: "failed", message: DIDNT });
  }

  async function wait() {
    set({ kind: "posting" });
    const r = await waitUntilLive(take.id, () => mounted.current);
    if (r === "live") { postingBuyIns.set(take.id, null); onChanged(); }
    else if (r === "unconfirmed") set({ kind: "unconfirmed" });
    else if (r === "failed") set({ kind: "failed", message: DIDNT });
  }

  // Checked once it's about 2 minutes old (the composer may still be sending it before then).
  useEffect(() => {
    if (failed) return;
    const id = window.setTimeout(() => { check(); }, Math.max(0, POSTING_STALE_MS - age(take)));
    return () => window.clearTimeout(id);
    // Once per take.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [take.id]);

  // Retry with the stored buy-in; without one (posted on another device), the minimum.
  useEffect(() => {
    if (state.kind === "failed" && postingBuyIns.get(take.id) == null) {
      fork<{ minStakeUsd: number }>("GET", "/config").then((c) => mounted.current && c.minStakeUsd > 0 && setMinStake(c.minStakeUsd)).catch(() => {});
    }
  }, [state.kind, take.id]);

  async function retry() {
    if (!address || !wallet) return set({ kind: "failed", message: "Your wallet isn't ready yet. Try again in a moment." });
    set({ kind: "working", text: "Sending your buy-in…" });
    try {
      await sendBuyIn(take.id, address, buyIn, signAndSubmit);
    } catch (e) {
      return set({ kind: "failed", message: e instanceof Error ? e.message : "Couldn't send your buy-in." });
    }
    await wait();
  }

  async function discard() {
    set({ kind: "working", text: "Discarding…" });
    // It landed after all: it'll go live.
    if (await isOnChain(take.id)) return wait();
    try {
      await social("DELETE", `takes/${take.id}`);
    } catch {
      return set({ kind: "failed", message: "Couldn't discard it. Try again." });
    }
    postingBuyIns.set(take.id, null);
    onChanged();
  }

  const status =
    state.kind === "failed" ? <><b className="down">Didn&apos;t post</b> · {state.message}</>
    : state.kind === "unconfirmed" ? <><b>On-chain, not showing yet</b> · your buy-in landed</>
    : state.kind === "working" ? <><b className="muted">{state.text}</b></>
    : state.kind === "confirmDiscard" ? <><b className="down">Discard this take?</b> · it never made it on-chain, so nobody saw it and no money moved</>
    : <><b className="muted">Posting…</b> · only you can see it</>;

  return (
    <div className="item">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img className="tile" src={topicImage((take as Take & { topic?: string }).topic)} alt="" />
      <div className="item-main">
        <div className="item-claim">{take.claim}</div>
        <div className="note">{status}</div>
        {state.kind === "failed" ? (
          <div className="posting-actions">
            <button className="pill small" onClick={retry}>Retry with {money(buyIn).replace(/\.00$/, "")}</button>
            <button className="pill small down" onClick={() => set({ kind: "confirmDiscard" })}>Discard</button>
          </div>
        ) : null}
        {state.kind === "confirmDiscard" ? (
          <div className="posting-actions">
            <button className="pill small down" onClick={discard}>Discard</button>
            <button className="pill small" onClick={() => set({ kind: "failed", message: DIDNT })}>Keep it</button>
          </div>
        ) : null}
        {state.kind === "unconfirmed" ? (
          <div className="posting-actions"><button className="pill small" onClick={wait}>Check again</button></div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * At launch (once per session): your posting takes older than ~2 minutes that the fork API says
 * aren't on-chain show in a sheet with Retry and Discard. The check also re-delivers the events of
 * any that did land, so those go live by themselves. Me's "My takes" lists them too.
 */
export function PostingAtLaunch() {
  const { phase, userId, social } = useSession();
  const pathname = usePathname();
  const [stuck, setStuck] = useState<Take[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (phase.kind !== "ready" || !userId) return;
    const key = `thesis.postingChecked.${userId}`;
    try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, "1"); } catch { /* private mode: check every load */ }
    let live = true;
    (async () => {
      const posting = await social<{ takes: Take[] }>("GET", "takes/posting").then((r) => r.takes, () => [] as Take[]);
      const stale = posting.filter((t) => age(t) >= POSTING_STALE_MS);
      const checked = await Promise.all(stale.map(async (t) => ((await isOnChain(t.id)) ? null : t)));
      const failed = checked.filter((t): t is Take => t !== null);
      if (live && failed.length) { setStuck(failed); setOpen(true); }
    })();
    return () => { live = false; };
  }, [phase.kind, userId, social]);

  if (!open || !stuck.length) return null;
  const close = () => setOpen(false);
  return (
    <div className="sheet-wrap" onClick={(e) => e.target === e.currentTarget && close()}>
      <div className="sheet" role="dialog" aria-label="Didn't post">
        <button className="x" aria-label="Close" onClick={close}>×</button>
        <h3>{stuck.length === 1 ? "A take didn't post" : `${stuck.length} takes didn't post`}</h3>
        <p className="muted small">Its buy-in never landed, so only you can see it. Send the same buy-in again, or discard it.</p>
        {stuck.map((t) => (
          <PostingRow key={t.id} take={t} failed onChanged={() => setStuck((s) => s.filter((x) => x.id !== t.id))} />
        ))}
        {pathname === "/me" ? (
          <button className="obtn plain" onClick={() => { close(); showMyTakes(); }}>See my takes</button>
        ) : (
          <Link className="obtn plain" href="/me?tab=takes" onClick={close}>See my takes</Link>
        )}
      </div>
    </div>
  );
}
