// Transport-neutral shapes shared by every iMessage provider adapter, so the
// reply logic (@thesis/agent) never imports a provider SDK directly.

export type Inbound = {
  /** Provider that delivered the message, e.g. "photon". */
  provider: string;
  /** Stable conversation id (DM or group chat). */
  chatId: string;
  chatType: "dm" | "group";
  /** Sender handle (E.164 phone or email); undefined if the provider has none. Never logged in full. */
  senderId: string | undefined;
  /** The provider's id for this message: a trade it asks for is keyed on it, so a redelivery never trades twice. */
  messageId?: string;
  /** A tapback ("like", "love", "laugh", ...) instead of a text: a like or love confirms a waiting trade. */
  reaction?: string;
  text: string;
};

const TAPBACK_TEXT: Record<string, string> = { Liked: "like", Loved: "love", Disliked: "dislike", "Laughed at": "laugh", Emphasized: "emphasize", Questioned: "question" };

/** "Liked “On it…”" → "like": how a tapback reads as text. Null for anything else. */
export function tapbackFromText(text: string): string | null {
  const m = text.match(/^(Liked|Loved|Disliked|Laughed at|Emphasized|Questioned) [“"].*[”"]$/s);
  return m ? TAPBACK_TEXT[m[1]] : null;
}

/** Returns the reply text, or null to stay quiet. */
export type Handler = (msg: Inbound) => Promise<string | null>;

export type Provider = {
  name: string;
  /** Connects and dispatches inbound text messages to `handler` until stopped. */
  run(handler: Handler): Promise<void>;
  stop(): Promise<void>;
};
