// One Phoenix send at a time in this process. Before each Phoenix order or close, the maker sync
// (lib.ts syncPhoenixMakers) reads Phoenix's active trader buffer and writes the whole account
// back: a Phoenix transaction of another wallet that landed in between would be lost (its fill,
// or a cash-out's withdrawal). So every send that names Phoenix's program, and the API's own
// Phoenix registrations, run here, one after another. Phoenix sends take well under a second; the
// rest of the API (Jupiter-only trades, reads) never waits on this.
//
// Other processes writing Phoenix on the fork (an e2e suite's in-process API) aren't covered:
// don't run those while the fork is being dogfooded, or expect a rare lost fill.
let tail: Promise<unknown> = Promise.resolve();

/** Runs `work` once every Phoenix send queued before it is done. */
export function withPhoenixLock<T>(work: () => Promise<T>): Promise<T> {
  const run = tail.then(work, work);
  tail = run.catch(() => {});
  return run;
}
