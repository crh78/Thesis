// marks: the marker's way in. The executor's marker (apps/executor/src/marker.ts) prices every
// pick of every open take with the settler's rules and posts one run here; apply_marks()
// (supabase/migrations/0038_live_marks.sql) writes picks' bases and marks, takes'
// returns and history, and open on-chain positions' live returns.
//
//   POST { marks: { legs: [...], takes: [...], positions: [...] } }
//   header x-marks-token: <MARKS_TOKEN>
//   → { ok: true, legs, takes, positions }   rows changed
//
// Idempotent: a retried run writes the same marks again, and bases are only ever set once.
//
// Secrets: MARKS_TOKEN (shared with the marker; requests aren't accepted without it), plus the
// platform's SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.

import { createClient } from "jsr:@supabase/supabase-js@2";

const TOKEN = Deno.env.get("MARKS_TOKEN") ?? "";
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function sameSecret(a: string, b: string) {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const MAX_ROWS = 5_000;

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  if (!TOKEN) return json(503, { error: "not_configured" });
  if (!sameSecret(req.headers.get("x-marks-token") ?? "", TOKEN)) return json(401, { error: "bad_token" });

  const text = await req.text();
  if (text.length > 4_000_000) return json(413, { error: "too_large" });
  let marks: { legs?: unknown[]; takes?: unknown[]; positions?: unknown[] };
  try {
    marks = JSON.parse(text)?.marks;
  } catch {
    return json(400, { error: "bad_json" });
  }
  if (!marks || typeof marks !== "object") return json(400, { error: "no_marks" });
  for (const k of ["legs", "takes", "positions"] as const) {
    const v = marks[k] ?? [];
    if (!Array.isArray(v)) return json(400, { error: `bad_${k}` });
    if (v.length > MAX_ROWS) return json(413, { error: `too_many_${k}` });
  }

  const { data, error } = await db.rpc("apply_marks", { p: marks });
  // A 5xx makes the marker retry the run on its next tick.
  if (error) return json(500, { error: "apply_failed", message: error.message });
  return json(200, { ok: true, ...(data as Record<string, number>) });
});
