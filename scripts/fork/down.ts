// pnpm fork:down — stops the Surfpool that `pnpm fork:up` started. A Surfpool started some other
// way (a terminal, `surfpool start`) is left alone. Fork state is in memory, so it's gone after
// this; the admin and settler keypairs in .data/fork/ stay and are reused by the next `fork:up`.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { PATHS, RPC_URL, main, surfpoolVersion } from "./lib.ts";

async function down(): Promise<void> {
  if (!existsSync(PATHS.pid)) {
    const running = await surfpoolVersion();
    console.log(
      running
        ? `The Surfpool at ${RPC_URL} wasn't started by \`pnpm fork:up\`, so it's left running. Stop it where it was started.`
        : "No fork running.",
    );
    return;
  }
  const pid = Number(readFileSync(PATHS.pid, "utf8").trim());
  try {
    // fork:up starts Surfpool detached in its own process group; stop the whole group.
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      console.log(`Process ${pid} is already gone.`);
    }
  }
  for (let i = 0; i < 20 && (await surfpoolVersion()); i++) await new Promise((r) => setTimeout(r, 250));
  if (await surfpoolVersion()) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  rmSync(PATHS.pid, { force: true });
  console.log(`Stopped Surfpool (pid ${pid}).`);
}

if (import.meta.main) await main(down);
