// Minimal structured logging. Never log message bodies or full handles.

export function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
}

/** "+18175551234" → "…1234". Keeps logs useful without leaking numbers or ids. */
export function mask(value: string | undefined): string | null {
  if (!value) return null;
  return `…${value.slice(-4)}`;
}
