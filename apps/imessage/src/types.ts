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
  text: string;
};

/** Returns the reply text, or null to stay quiet. */
export type Handler = (msg: Inbound) => Promise<string | null>;

export type Provider = {
  name: string;
  /** Connects and dispatches inbound text messages to `handler` until stopped. */
  run(handler: Handler): Promise<void>;
  stop(): Promise<void>;
};
