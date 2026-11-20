// What the bots did, kept in Supabase (bot_events) through the source function's
// POST /source/bot-events, so replies, skips and failures can be looked back on after Railway's
// logs scroll away. Events queue in memory and go out in batches on flush(); a failed send keeps
// them for the next flush. Telemetry never throws and never holds up a reply.
import type { BasketConfig } from "./basket.ts";

export type Recorder = {
  /** Queues one event: `ref` (the mention id), `author` and `what` get their own columns, the rest goes to data. */
  record(event: string, fields?: Record<string, unknown>): void;
  /** Sends what's queued. Never throws. */
  flush(): Promise<void>;
};

const BATCH = 100;
/** Past this the oldest events are dropped (the endpoint down for hours). */
const MAX_QUEUE = 2000;

export function botEvents(
  bot: "x" | "imessage",
  cfg: Pick<BasketConfig, "draftsUrl" | "botSecret"> | null,
  opts: { fetch?: typeof fetch; onError?: (message: string) => void } = {},
): Recorder {
  if (!cfg) return { record() {}, async flush() {} };
  const url = cfg.draftsUrl.replace(/\/drafts\/?$/, "/bot-events");
  const send = opts.fetch ?? fetch;
  const onError = opts.onError ?? (() => {});
  let queue: Record<string, unknown>[] = [];
  let sending: Promise<void> | null = null;

  async function sendAll() {
    while (queue.length) {
      const batch = queue.slice(0, BATCH);
      let res: Response;
      try {
        res = await send(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-bot-secret": cfg!.botSecret },
          body: JSON.stringify({ bot, events: batch }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (e) {
        onError(`telemetry unreachable: ${(e as Error).message}`.slice(0, 200));
        return; // kept for the next flush
      }
      if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) {
        // A 4xx won't get better by resending the same batch: drop it.
        if (!res.ok) onError(`telemetry refused: ${res.status} ${(await res.text().catch(() => "")).slice(0, 120)}`);
        queue = queue.slice(batch.length);
        continue;
      }
      onError(`telemetry failed: ${res.status}`);
      return;
    }
  }

  return {
    record(event, fields = {}) {
      queue.push({ at: new Date().toISOString(), event, ...fields });
      if (queue.length > MAX_QUEUE) queue = queue.slice(queue.length - MAX_QUEUE);
    },
    async flush() {
      if (!sending) sending = sendAll().catch(() => {}).finally(() => { sending = null; });
      await sending;
    },
  };
}
