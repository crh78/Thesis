// What the bot has seen and how much it has replied today, in one JSON file (apps/x/.data/,
// gitignored). Saved after every mention, so a restart never answers a mention twice.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BotPost, Held, Memory, Shared } from "./bot.ts";

export type State = {
  /** The newest mention handled; the next poll asks for mentions after it. */
  sinceId: string | null;
  /** When the bot first ran: until it has a sinceId, mentions since then (never the old backlog). */
  startedAt: string;
  /** UTC day the counts below are for. */
  day: string;
  replies: number;
  byAuthor: Record<string, number>;
  byConversation: Record<string, number>;
  /** X user ids who said "stop" (kept across days, until they say "start"). */
  optedOut: Record<string, true>;
  /** What each of the bot's replies carries (its draft, or the take it traded), by reply id. */
  posts: Record<string, BotPost>;
  /** The take each X user traded in each conversation ("<user id>|<conversation id>"), for "sell". */
  held: Record<string, Held>;
  /** A basket built for a post, shared by everyone replying under it ("<post id>|back|fade"). */
  shared: Record<string, Shared>;
  /** X user ids known to have a Thesis account (never asked again). */
  known: Record<string, true>;
  /** X user ids without a Thesis account who already got their one reply. */
  onceReplied: Record<string, true>;
};

const today = () => new Date().toISOString().slice(0, 10);
const POSTS_MAX = 2000;
const HELD_MAX = 2000;
const SHARED_MAX = 500;
export const SHARED_TTL_MS = 24 * 60 * 60_000;

export function loadState(path: string): State {
  let s: Partial<State> = {};
  try {
    s = JSON.parse(readFileSync(path, "utf8"));
  } catch { /* first run */ }
  const fresh = s.day !== today();
  return {
    sinceId: s.sinceId ?? null,
    // X wants whole seconds.
    startedAt: s.startedAt ?? new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    day: today(),
    replies: fresh ? 0 : s.replies ?? 0,
    byAuthor: fresh ? {} : s.byAuthor ?? {},
    byConversation: fresh ? {} : s.byConversation ?? {},
    optedOut: s.optedOut ?? {},
    posts: s.posts ?? {},
    held: s.held ?? {},
    shared: s.shared ?? {},
    known: s.known ?? {},
    onceReplied: s.onceReplied ?? {},
  };
}

export function saveState(path: string, s: State): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, path);
}

/** A new UTC day resets the counts. */
export function rollDay(s: State): void {
  if (s.day === today()) return;
  s.day = today();
  s.replies = 0;
  s.byAuthor = {};
  s.byConversation = {};
}

/** Keeps the newest `max` keys (objects keep insertion order). */
function bound<T>(o: Record<string, T>, max: number): void {
  const keys = Object.keys(o);
  for (const k of keys.slice(0, Math.max(0, keys.length - max))) delete o[k];
}

/** The bot's memory over its state file. */
export function memoryOf(s: State, now = () => Date.now()): Memory & {
  rememberPost(replyId: string, p: BotPost): void;
  rememberHeld(authorId: string, conversation: string, h: Held): void;
  rememberShared(parentId: string, side: "back" | "fade", v: Omit<Shared, "at">): void;
} {
  return {
    botPost: (id) => s.posts[id],
    held: (authorId, conversation) => s.held[`${authorId}|${conversation}`],
    shared: (parentId, side) => {
      const v = s.shared[`${parentId}|${side}`];
      return v && now() - v.at < SHARED_TTL_MS ? v : undefined;
    },
    rememberPost(replyId, p) {
      s.posts[replyId] = p;
      bound(s.posts, POSTS_MAX);
    },
    rememberHeld(authorId, conversation, h) {
      const k = `${authorId}|${conversation}`;
      delete s.held[k];
      s.held[k] = h;
      bound(s.held, HELD_MAX);
    },
    rememberShared(parentId, side, v) {
      s.shared[`${parentId}|${side}`] = { ...v, at: now() };
      for (const [k, x] of Object.entries(s.shared)) if (now() - x.at >= SHARED_TTL_MS) delete s.shared[k];
      bound(s.shared, SHARED_MAX);
    },
  };
}
