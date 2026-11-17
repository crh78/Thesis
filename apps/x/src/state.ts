// What the bot has seen and how much it has replied today, in one JSON file (apps/x/.data/,
// gitignored). Saved after every mention, so a restart never answers a mention twice.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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
};

const today = () => new Date().toISOString().slice(0, 10);

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
