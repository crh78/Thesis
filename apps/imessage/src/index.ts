// iMessage surface entry point: provider → @thesis/agent → same chat.
import { bluebubbles } from "./providers/bluebubbles.ts";
import { sendblue } from "./providers/sendblue.ts";
import type { Provider } from "./types.ts";
import { createReply } from "./reply.ts";
import { log } from "./log.ts";

// IMESSAGE_PROVIDER picks the transport: "bluebubbles" (free, group chats) or "sendblue" (default).
function pickProvider(): Provider {
  if (process.env.IMESSAGE_PROVIDER === "bluebubbles") {
    const url = process.env.BLUEBUBBLES_URL;
    const password = process.env.BLUEBUBBLES_PASSWORD;
    if (!url || !password) {
      console.error("Missing BLUEBUBBLES_URL / BLUEBUBBLES_PASSWORD. See apps/imessage/README.md.");
      process.exit(1);
    }
    return bluebubbles({ url, password });
  }
  const apiKey = process.env.SENDBLUE_API_KEY;
  const apiSecret = process.env.SENDBLUE_API_SECRET;
  const fromNumber = process.env.SENDBLUE_FROM_NUMBER;
  if (!apiKey || !apiSecret || !fromNumber) {
    console.error("Missing SENDBLUE_API_KEY / SENDBLUE_API_SECRET / SENDBLUE_FROM_NUMBER. Copy .env.example to .env and fill them in.");
    process.exit(1);
  }
  return sendblue({ apiKey, apiSecret, fromNumber });
}

let reply: ReturnType<typeof createReply>;
try {
  reply = createReply();
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const provider = pickProvider();

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log("shutdown", { signal });
  await provider.stop().catch(() => {});
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

log("starting", { provider: provider.name });
void reply.agent.warm().then(() => log("take builder warm"));
try {
  await provider.run(reply.handler);
  log("stream ended");
} catch (err) {
  console.error("iMessage agent failed to start:", err instanceof Error ? err.message : err);
  console.error(provider.name === "bluebubbles"
    ? "Check BLUEBUBBLES_URL / BLUEBUBBLES_PASSWORD and that the BlueBubbles server is running."
    : "Check SENDBLUE_API_KEY / SENDBLUE_API_SECRET (`sendblue show-keys`).");
  process.exit(1);
}
