// House style for chat replies, enforced after the model writes them.

/** iMessage shows markdown literally, and we never send em or en dashes. */
export function cleanReply(text: string): string {
  return text
    .replace(/\*\*/g, "")
    // "Name 40% — why" → "Name 40%: why"; any other dash → comma.
    .replace(/(\d%)\s*[—–]\s*/g, "$1: ")
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/[ \t]+$/gm, "")
    .trim();
}
