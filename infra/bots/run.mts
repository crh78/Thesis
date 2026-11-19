// Runs both chat bots in one process tree, for one Railway service (infra/bots/README.md):
// the iMessage bot (apps/imessage, Sendblue) and the X bot (apps/x, @yourthesisxyz).
// The X bot starts only when its X keys are set, so the iMessage bot can run without them.
// If either bot exits, this exits too, and Railway restarts the service.
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const X_KEYS = ["X_CONSUMER_KEY", "X_CONSUMER_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET"];

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), bot: "run", event, ...fields }));
}

const bots: { name: string; dir: string; on: boolean; why?: string }[] = [
  { name: "imessage", dir: "apps/imessage", on: process.env.BOTS_IMESSAGE !== "0" },
  {
    name: "x", dir: "apps/x",
    on: process.env.BOTS_X !== "0" && X_KEYS.every((k) => process.env[k]),
    why: X_KEYS.filter((k) => !process.env[k]).join(", "),
  },
];

const running: ChildProcess[] = [];
let stopping = false;
function stop(code: number): void {
  if (stopping) return;
  stopping = true;
  for (const c of running) c.kill("SIGTERM");
  setTimeout(() => process.exit(code), 3000).unref();
}

for (const b of bots) {
  if (!b.on) {
    log("skipped", { name: b.name, ...(b.why ? { missing: b.why } : { disabled: true }) });
    continue;
  }
  // Each bot's own lines are already one JSON object each; tag them with the bot.
  const child = spawn(process.execPath, ["src/index.ts"], { cwd: `${root}/${b.dir}`, stdio: ["ignore", "pipe", "pipe"], env: process.env });
  const tag = (stream: NodeJS.WriteStream) => (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) if (line) stream.write(`[${b.name}] ${line}\n`);
  };
  child.stdout!.on("data", tag(process.stdout));
  child.stderr!.on("data", tag(process.stderr));
  child.on("exit", (code, signal) => {
    log("exited", { name: b.name, code, signal });
    stop(code || 1);
  });
  running.push(child);
  log("started", { name: b.name, pid: child.pid });
}

if (!running.length) {
  log("nothing to run");
  process.exit(1);
}
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => stop(0));
