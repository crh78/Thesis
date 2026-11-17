// Inbound iMessage → @thesis/agent → reply text (or null to stay quiet).
import { createAgent, type Agent } from "@thesis/agent";
import type { Handler } from "./types.ts";
import { log, mask } from "./log.ts";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} (see apps/imessage/.env.example)`);
  return v;
}

export function createReply(): { handler: Handler; agent: Agent } {
  const functions = `${required("SUPABASE_URL").replace(/\/$/, "")}/functions/v1`;
  const agent = createAgent({
    openaiApiKey: required("OPENAI_API_KEY"),
    model: process.env.OPENAI_AGENT_MODEL || "gpt-6-luna",
    effort: "low",
    basket: {
      takeBuilderUrl: `${functions}/take-builder`,
      takeBuilderSecret: required("SECURITIES_INDEX_SECRET"),
      openUrl: `${functions}/open`,
      app: process.env.THESIS_APP === "prod" ? "prod" : "dev",
    },
    log,
  });

  const handler: Handler = async (msg) => {
    const text = msg.text.trim();
    if (!text) return null;
    return agent.respond({ chatId: msg.chatId, chatType: msg.chatType, sender: mask(msg.senderId), text });
  };
  return { handler, agent };
}
