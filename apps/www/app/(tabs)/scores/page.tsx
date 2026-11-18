"use client";
// Scores, like the iOS ScoresView on the fork: three boards (own P&L, made for backers, faders),
// each ranked by dollars or by percent, over a week, a month or all time. Your own line is pinned
// on top; the list leaves you out and everyone keeps their rank on the full board.
import Link from "next/link";
import { useEffect, useState } from "react";
import Avatar from "@/components/Avatar";
import { ProfileMenuButton } from "@/components/Drawer";
import { money, pct, rpcNow, type Person, type Profile } from "@/lib/data";
import { useSession } from "@/lib/session";

type Board = "own" | "backers" | "faders";
type Row = { person: Person & { takes?: number }; cash: number; pct: number };
/** Your own line from `leaderboard` (given `p_viewer`): your rank on the whole board, in the order asked. */
type Viewer = Row & { rank: number };
/** `leaderboard` sends today's array, or `{ rows, viewer }` when it's given `p_viewer`. */
type BoardReply = Row[] | { rows: Row[]; viewer: Viewer | null };
/**
 * What the Scores list shows: `ordered` when the database sorted it the way asked (it takes
 * `p_dir`), else the top of the board turned around here; `viewer` is undefined when it didn't say.
 */
type Loaded = { rows: Row[]; ordered: boolean; viewer?: Viewer | null };

// Whether `leaderboard` takes `p_dir` / `p_viewer` (its 0054+ migration). Null until a call says;
// false after it refused them, so later loads go straight to the older call.
let boardV2: boolean | null = null;

async function loadBoard(args: Record<string, unknown>, desc: boolean, viewer: string | null): Promise<Loaded> {
  // Only the new parameters that matter: highest first for a signed-out visitor is today's call.
  const extra = { ...(desc ? {} : { p_dir: "asc" }), ...(viewer ? { p_viewer: viewer } : {}) };
  if (boardV2 !== false && Object.keys(extra).length) {
    try {
      const r = await rpcNow<BoardReply>("leaderboard", { ...args, ...extra });
      boardV2 = true;
      return Array.isArray(r) ? { rows: r, ordered: true } : { rows: r.rows ?? [], ordered: true, viewer: r.viewer ?? null };
    } catch (e) {
      // PostgREST answers 404 (no such function) for parameters it doesn't know. Anything else
      // is a real failure, which the older call below will most likely hit too.
      if (/: 40[04]$/.test(e instanceof Error ? e.message : "")) boardV2 = false;
    }
  }
  return { rows: await rpcNow<Row[]>("leaderboard", args), ordered: desc };
}

const PERIODS = [["week", "Week"], ["month", "Month"], ["all", "All time"]] as const;
const BOARDS = [["own", "Own P&L"], ["backers", "For backers"], ["faders", "Faders"]] as const;
const CAPTION: Record<Board, string> = {
  own: "Own P&L: what each account made on its own positions that have settled or been sold.",
  backers: "Made for backers: what everyone who backed an account's takes made, losses subtracted. Fades and the author's own money don't count.",
  faders: "Faders: what each account made fading other people's takes, on fades that have settled or been sold.",
};
// The most rows `leaderboard` returns (its cap). "Lowest first" asks it for the bottom of the board
// (`p_dir`); before that migration, it turns the top around here, which is the true bottom only
// while the whole board fits in one read.
const BOARD_MAX = 200;
const EMPTY: Record<Board, string> = {
  own: "Nobody is on the board yet.",
  backers: "Nobody has posted a take yet.",
  faders: "Nobody has faded a take yet.",
};

export default function ScoresPage() {
  const { snapshot } = useSession();
  const me = snapshot?.profile;
  const [period, setPeriod] = useState<(typeof PERIODS)[number][0]>("week");
  const [board, setBoard] = useState<Board>("own");
  const [byCash, setByCash] = useState(true);
  // Highest first by default (who made the most); flip it to see who lost the most.
  const [desc, setDesc] = useState(true);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const rows = loaded?.rows ?? null;
  const [mine, setMine] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoaded(null);
    setError(null);
    loadBoard({ p_period: period, p_board: board, p_sort: byCash ? "cash" : "pct", p_limit: BOARD_MAX }, desc, me?.id ?? null)
      .then((r) => live && setLoaded(r))
      .catch((e) => { if (live) { setLoaded({ rows: [], ordered: true }); setError(e instanceof Error ? e.message : String(e)); } });
    return () => { live = false; };
  }, [period, board, byCash, desc, me?.id]);

  useEffect(() => {
    if (me?.id) rpcNow<Profile | null>("profile", { p_profile: me.id }).then(setMine).catch(() => {});
  }, [me?.id]);

  // Ranks follow the order shown: #1 is the top of the list, whichever way it's sorted.
  const sorted = loaded?.ordered ? (rows ?? []) : [...(rows ?? [])].sort((a, b) => (desc ? 1 : -1) * (byCash ? b.cash - a.cash : b.pct - a.pct));
  const myIndex = sorted.findIndex((r) => r.person.id === me?.id);
  // Your rank on the whole board when the database sends it (even outside the rows shown).
  const viewer = loaded?.viewer;
  const myRow: Row | null = viewer !== undefined ? viewer : myIndex >= 0 ? sorted[myIndex] : null;
  const myRank = viewer ? viewer.rank : myIndex + 1;
  // Not on the board: like the app, the backers board still shows what your takes made all time.
  const myCash = myRow?.cash ?? (board === "backers" ? mine?.backers_made ?? 0 : 0);
  const myPct = myRow?.pct ?? (board === "backers" ? mine?.backers_pct ?? 0 : 0);
  const myTakes = myRow?.person.takes ?? mine?.takes ?? 0;
  const periodCaption = period === "all" ? "all time" : `this ${period}`;
  const top = sorted.map((r, i) => ({ r, rank: i + 1 })).filter(({ r }) => r.person.id !== me?.id).slice(0, 25);
  // A board longer than one read: lowest first would show the bottom of the top 200, not the
  // board's real bottom, with made-up ranks. Say so instead of ranking it.
  const partial = !desc && !loaded?.ordered && (rows?.length ?? 0) >= BOARD_MAX;

  const primary = (cash: number, p: number) => (byCash ? money(cash, true) : pct(p));
  const secondary = (cash: number, p: number) => (byCash ? pct(p) : money(cash, true));

  return (
    <main className="page scores">
      <header className="topbar">
        <ProfileMenuButton />
        <span />
        <span />
      </header>
      <h1 className="title">Scores</h1>

      <div className="segmented" role="tablist" aria-label="Period">
        {PERIODS.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={period === k} className={period === k ? "on" : ""} onClick={() => setPeriod(k)}>{l}</button>
        ))}
      </div>

      <div className="score-tabs">
        <nav className="utabs" role="tablist" aria-label="Board">
          {BOARDS.map(([k, l]) => (
            <button key={k} role="tab" aria-selected={board === k} className={board === k ? "on" : ""} onClick={() => setBoard(k)}>{l}</button>
          ))}
        </nav>
      </div>

      {/* Rank by dollars or percent, highest or lowest first. */}
      <div className="sort-row">
        <span className="caps">Rank by</span>
        <div className="mini-seg" role="radiogroup" aria-label="Rank by">
          <button role="radio" aria-checked={byCash} className={byCash ? "on" : ""} onClick={() => setByCash(true)}>$</button>
          <button role="radio" aria-checked={!byCash} className={!byCash ? "on" : ""} onClick={() => setByCash(false)}>%</button>
        </div>
        <button className="sort-pill mono" onClick={() => setDesc((d) => !d)} aria-label={desc ? "Highest first. Show lowest first instead" : "Lowest first. Show highest first instead"}>
          <svg viewBox="0 0 12 12" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            {desc ? <path d="M6 2v8M3 7l3 3 3-3" /> : <path d="M6 10V2M3 5l3-3 3 3" />}
          </svg>
          {desc ? "HIGHEST FIRST" : "LOWEST FIRST"}
        </button>
      </div>

      {me ? (
        <LeaderRow
          me
          rank={myRow && !partial ? `#${myRank}` : "—"}
          person={me}
          title="You"
          subtitle={`${myTakes} ${myTakes === 1 ? "take" : "takes"} · ${periodCaption}`}
          primary={primary(myCash, myPct)}
          secondary={secondary(myCash, myPct)}
          negative={(byCash ? myCash : myPct) < 0}
        />
      ) : null}

      {top.map(({ r, rank }) => (
        <LeaderRow
          key={r.person.id}
          rank={partial ? "·" : String(rank)}
          gold={rank === 1 && desc}
          person={r.person}
          title={r.person.handle ? `@${r.person.handle}` : (r.person.display_name ?? "Someone")}
          subtitle={`${r.person.takes ?? 0} ${(r.person.takes ?? 0) === 1 ? "take" : "takes"}`}
          primary={primary(r.cash, r.pct)}
          secondary={secondary(r.cash, r.pct)}
          negative={(byCash ? r.cash : r.pct) < 0}
        />
      ))}

      {rows == null ? <p className="muted scores-empty">Loading…</p> : null}
      {rows != null && error ? <p className="err scores-empty">Couldn&apos;t load Scores. {error}</p> : null}
      {rows != null && !error && top.length === 0 && !myRow ? <p className="muted scores-empty">{EMPTY[board]}</p> : null}

      {partial ? <p className="muted small scores-caption">Lowest first lists the bottom of the top {BOARD_MAX} for now, so it shows no ranks.</p> : null}
      <p className="muted small scores-caption">{CAPTION[board]}</p>
    </main>
  );
}

function LeaderRow(props: { rank: string; person: Pick<Person, "avatar_url" | "handle">; title: string; subtitle: string; primary: string; secondary: string; negative: boolean; me?: boolean; gold?: boolean }) {
  const body = (
    <>
      <span className={`lrank mono${props.gold ? " gold" : ""}`}>{props.rank}</span>
      <Avatar person={props.person} size={40} />
      <span className="lwho">
        <b>{props.title}</b>
        <span className="muted small">{props.subtitle}</span>
      </span>
      <span className="lnums">
        <b className={`mono ${props.negative ? "down" : "up"}`}>{props.primary}</b>
        <span className="mono muted small">{props.secondary}</span>
      </span>
    </>
  );
  const cls = `lrow${props.me ? " lrow-me" : ""}`;
  return props.person.handle ? <Link href={props.me ? "/me" : `/u/${props.person.handle}`} className={cls}>{body}</Link> : <div className={cls}>{body}</div>;
}
