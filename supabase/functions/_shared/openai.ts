// OpenAI client shared by take-builder (per-take copy) and securities-index
// (catalog descriptions). Both use a fast model with reasoning off.
// Secrets: OPENAI_API_KEY; OPENAI_FAST_MODEL picks the model.

import OpenAI from "npm:openai@7";

// Created on first use, so functions still boot (and fall back) without a key.
let client: OpenAI | null = null;
function openai(): OpenAI {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  return (client ??= new OpenAI({ apiKey }));
}
export const FAST_MODEL = Deno.env.get("OPENAI_FAST_MODEL") ?? "gpt-6-luna";

/** One strict-JSON call. `schema` is a JSON Schema object. */
export async function jsonCall<T>(system: string, user: unknown, name: string, schema: object, opts: { timeoutMs?: number; maxTokens?: number; priority?: boolean; model?: string } = {}): Promise<T> {
  const res = await openai().responses.create(
    {
      model: opts.model ?? FAST_MODEL,
      input: [
        { role: "system", content: system },
        { role: "user", content: typeof user === "string" ? user : JSON.stringify(user) },
      ],
      reasoning: { effort: "none" },
      max_output_tokens: opts.maxTokens ?? 1200,
      text: { format: { type: "json_schema", name, strict: true, schema } },
      // Priority tier: steadier latency for user-facing calls (standard spiked to 13 s in tests).
      ...(opts.priority ? { service_tier: "priority" } : {}),
    } as never,
    { timeout: opts.timeoutMs ?? 60_000, maxRetries: 0 },
  );
  if (res.status !== "completed") throw new Error(`response ${res.status}`);
  return JSON.parse(res.output_text) as T;
}

export type Tool = {
  name: string;
  description: string;
  /** JSON Schema for the arguments (strict: every property required, no extras). */
  parameters: object;
  run: (args: Record<string, unknown>) => Promise<string> | string;
};

/**
 * A strict-JSON answer the model may look things up for first: it can call `tools` (in parallel)
 * for up to `rounds - 1` turns, and the last turn has to answer. Reasoning stays off, so each
 * turn is one fast call. `timeoutMs` covers the whole exchange; `calls` reports what it ran.
 *
 * `fresh`: speculate. The first turn also runs once with tools off, in parallel. If the model
 * asks to look things up and the lookups turn up nothing new (`fresh()` is false afterwards),
 * that tools-off answer is used instead of a second turn, so a search that only restates the
 * question costs no extra round trip. `rounds` in the result is 1 then, and `speculated` true.
 */
export async function toolCall<T>(system: string, user: unknown, tools: Tool[], name: string, schema: object, opts: { timeoutMs?: number; maxTokens?: number; priority?: boolean; model?: string; rounds?: number; fresh?: () => boolean; reasoning?: "none" | "low" | "medium"; thoughts?: boolean } = {}): Promise<{ out: T; calls: string[]; rounds: number; speculated?: boolean; thoughts: string[] }> {
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  const rounds = opts.rounds ?? 3;
  const byName = new Map(tools.map((t) => [t.name, t]));
  // deno-lint-ignore no-explicit-any
  const input: any[] = [
    { role: "system", content: system },
    { role: "user", content: typeof user === "string" ? user : JSON.stringify(user) },
  ];
  const calls: string[] = [];
  // `thoughts`: the model's reasoning summaries, for looking back on a build (the bots' traces).
  // OpenAI never returns the reasoning itself, only a summary of it.
  const effort = opts.reasoning ?? "none";
  const reasoning = { effort, ...(opts.thoughts && effort !== "none" ? { summary: "auto" } : {}) };
  const thoughts: string[] = [];
  // deno-lint-ignore no-explicit-any
  const think = (res: any, label: string, into = thoughts) => {
    // deno-lint-ignore no-explicit-any
    for (const o of (res?.output ?? []) as any[]) {
      if (o.type !== "reasoning") continue;
      // deno-lint-ignore no-explicit-any
      const text = (o.summary ?? []).map((s: any) => s.text).filter(Boolean).join("\n\n");
      if (text) into.push(`[${label}] ${text}`);
    }
  };
  // deno-lint-ignore no-explicit-any
  const ask = (choice: "auto" | "none", left: number): Promise<any> => openai().responses.create(
    {
      model: opts.model ?? FAST_MODEL,
      input: [...input],
      tools: tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: true })),
      tool_choice: choice,
      parallel_tool_calls: true,
      store: false,
      reasoning,
      max_output_tokens: opts.maxTokens ?? 1200,
      text: { format: { type: "json_schema", name, strict: true, schema } },
      ...(opts.priority ? { service_tier: "priority" } : {}),
    } as never,
    { timeout: left, maxRetries: 0 },
  );
  const plainThoughts: string[] = [];
  let plain: Promise<T | null> | null = null;
  for (let round = 1; ; round++) {
    const left = deadline - Date.now();
    if (left < 300) throw new Error("timed out");
    if (round === 1 && opts.fresh && rounds > 1) {
      plain = ask("none", left).then((r) => {
        if (r.status !== "completed") return null;
        think(r, "answer without searching", plainThoughts);
        return JSON.parse(r.output_text) as T;
      }).catch(() => null);
    }
    const res = await openai().responses.create(
      {
        model: opts.model ?? FAST_MODEL,
        input,
        tools: tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: true })),
        tool_choice: round < rounds ? "auto" : "none",
        parallel_tool_calls: true,
        store: false,
        reasoning,
        max_output_tokens: opts.maxTokens ?? 1200,
        text: { format: { type: "json_schema", name, strict: true, schema } },
        ...(opts.priority ? { service_tier: "priority" } : {}),
      } as never,
      { timeout: left, maxRetries: 0 },
    );
    if (res.status !== "completed") throw new Error(`response ${res.status}`);
    think(res, `round ${round}`);
    // deno-lint-ignore no-explicit-any
    const fnCalls = (res.output as any[]).filter((o) => o.type === "function_call");
    if (!fnCalls.length) return { out: JSON.parse(res.output_text) as T, calls, rounds: round, thoughts };
    input.push(...res.output);
    const outputs = await Promise.all(fnCalls.map(async (c) => {
      const tool = byName.get(c.name);
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(c.arguments || "{}");
      } catch { /* bad arguments: the tool gets none */ }
      calls.push(`${c.name}(${JSON.stringify(args)})`);
      const output = tool ? await tool.run(args) : `unknown tool ${c.name}`;
      return { type: "function_call_output", call_id: c.call_id, output };
    }));
    input.push(...outputs);
    if (round === 1 && plain && opts.fresh && !opts.fresh()) {
      const out = await plain;
      if (out) return { out, calls, rounds: 1, speculated: true, thoughts: [...thoughts, ...plainThoughts] };
    }
  }
}
