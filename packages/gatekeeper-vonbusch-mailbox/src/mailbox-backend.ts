// Datenzugriff des Mailbox-Gatekeepers, hinter einem austauschbaren Adapter (wie K3/ErpAdapter).
//
// `MailboxBackend` ist die transport-freie Fach-Schnittstelle, die `MailboxSessionCore` benutzt.
//   - `McpMailboxBackend` spricht den echten agentic-inbox `/mcp` (AgentMail-artig) und erzwingt die
//     VON-1798-Mailbox-Verengung (`pin-mailbox.ts`) als Defense-in-Depth auf jedem `tools/call`.
//   - `MemoryMailboxBackend` ist ein In-Memory-Double für workerd-freie tsx-Tests.
//
// Wichtig: Die gepinnte Mailbox ist NIE ein Argument, das vom Gadget kommt — sie steckt in den
// DO-`props`. Das schließt die per-mailbox-authz-Lücke aus dem Security-Review an der Wurzel.

import { buildPinPlan, gateToolCall, type McpTool, type PinConfig, type PinPlan } from "./pin-mailbox";
import { upstreamCall, type UpstreamSession } from "./mcp-client";

/** Ein E-Mail-Thread (Konversation) in der Mailbox. */
export type MailboxThread = {
  id: string;
  subject: string;
  /** Kurzvorschau / Snippet des letzten Beitrags. */
  snippet?: string;
  /** ISO-8601-Zeitpunkt der letzten Aktivität. */
  updatedAt?: string;
};

/** Eine einzelne Nachricht in der Mailbox. */
export type MailboxMessage = {
  id: string;
  threadId?: string;
  from: string;
  to: string[];
  subject: string;
  text: string;
  receivedAt?: string;
};

/** Entwurf einer neu zu sendenden Nachricht. */
export type MailboxDraft = {
  to: string[];
  subject: string;
  text: string;
};

/** Fach-Schnittstelle: alle Operationen sind bereits auf EINE Mailbox bezogen. */
export interface MailboxBackend {
  // --- Reads (Observations) ---
  listThreads(mailbox: string, query?: string): Promise<MailboxThread[]>;
  getThread(mailbox: string, threadId: string): Promise<MailboxThread | null>;
  listMessages(mailbox: string, threadId?: string): Promise<MailboxMessage[]>;
  getMessage(mailbox: string, messageId: string): Promise<MailboxMessage | null>;
  // --- Writes (Actions) ---
  sendMessage(mailbox: string, draft: MailboxDraft): Promise<{ id: string }>;
  replyToThread(mailbox: string, threadId: string, text: string): Promise<{ id: string }>;
}

// ---------------------------------------------------------------------------
// MCP-Backend gegen den echten agentic-inbox `/mcp`.

/** Tool-Namen des agentic-inbox-Upstreams (AgentMail-artig, siehe VON-1798-Review). */
export const MAILBOX_TOOLS = {
  listThreads: "list_threads",
  getThread: "get_thread",
  listMessages: "list_messages",
  getMessage: "get_message",
  sendMessage: "send_message",
  reply: "reply",
} as const;

const MAILBOX_PARAM = "inbox_id";

export type McpBackendConfig = {
  upstreamUrl: string;
  /** Bearer-Token für den Upstream (Live-Bind-Secret, CEO-Gate). */
  authToken?: string;
};

/**
 * Extrahiert den `content[0].text` eines MCP-`tools/call`-Ergebnisses und parst ihn als JSON.
 * agentic-inbox liefert strukturierte Ergebnisse als JSON-Text im Content-Block.
 */
function parseToolResult<T>(result: unknown): T {
  const content = (result as { content?: Array<{ type: string; text?: string }> })?.content ?? [];
  const text = content.find(c => c.type === "text")?.text;
  if (text === undefined) throw new Error("MCP-Tool-Ergebnis ohne Text-Content.");
  return JSON.parse(text) as T;
}

export class McpMailboxBackend implements MailboxBackend {
  #session: UpstreamSession = { sessionId: null };
  #plan: PinPlan | null = null;

  constructor(private readonly config: McpBackendConfig) {}

  /** Lädt den Tool-Katalog einmalig und baut den Pin-Plan (Verengung auf die Mailbox). */
  async #ensurePlan(mailbox: string): Promise<PinPlan> {
    if (this.#plan) return this.#plan;
    const listResult = await upstreamCall(
      this.config.upstreamUrl, "tools/list", {}, this.#session, this.config.authToken);
    const tools = ((listResult as { tools?: McpTool[] }).tools ?? []);
    this.#plan = buildPinPlan(tools, this.#pinConfig(mailbox));
    return this.#plan;
  }

  #pinConfig(mailbox: string): PinConfig {
    return { mailbox, mailboxParam: MAILBOX_PARAM };
  }

  /**
   * Führt einen `tools/call` durch — mit harter Mailbox-Verengung über `gateToolCall`. Selbst wenn
   * (durch einen Bug oberhalb) eine fremde `inbox_id` in `args` läge, verweigert das Gate sie;
   * fehlt sie, wird die gepinnte Mailbox injiziert. Fail-closed.
   */
  async #call(mailbox: string, tool: string, args: Record<string, unknown>): Promise<unknown> {
    const plan = await this.#ensurePlan(mailbox);
    const gate = gateToolCall(tool, args, plan, this.#pinConfig(mailbox));
    if (!gate.allowed) {
      throw new Error(gate.result.content[0]?.text ?? `Tool "${tool}" durch Mailbox-Pin verweigert.`);
    }
    return upstreamCall(
      this.config.upstreamUrl, "tools/call",
      { name: tool, arguments: gate.args }, this.#session, this.config.authToken);
  }

  async listThreads(mailbox: string, query?: string): Promise<MailboxThread[]> {
    const r = await this.#call(mailbox, MAILBOX_TOOLS.listThreads, query ? { query } : {});
    return parseToolResult<{ threads?: MailboxThread[] }>(r).threads ?? [];
  }

  async getThread(mailbox: string, threadId: string): Promise<MailboxThread | null> {
    const r = await this.#call(mailbox, MAILBOX_TOOLS.getThread, { thread_id: threadId });
    return parseToolResult<MailboxThread | null>(r);
  }

  async listMessages(mailbox: string, threadId?: string): Promise<MailboxMessage[]> {
    const r = await this.#call(mailbox, MAILBOX_TOOLS.listMessages, threadId ? { thread_id: threadId } : {});
    return parseToolResult<{ messages?: MailboxMessage[] }>(r).messages ?? [];
  }

  async getMessage(mailbox: string, messageId: string): Promise<MailboxMessage | null> {
    const r = await this.#call(mailbox, MAILBOX_TOOLS.getMessage, { message_id: messageId });
    return parseToolResult<MailboxMessage | null>(r);
  }

  async sendMessage(mailbox: string, draft: MailboxDraft): Promise<{ id: string }> {
    const r = await this.#call(mailbox, MAILBOX_TOOLS.sendMessage, {
      to: draft.to, subject: draft.subject, text: draft.text,
    });
    return parseToolResult<{ id: string }>(r);
  }

  async replyToThread(mailbox: string, threadId: string, text: string): Promise<{ id: string }> {
    const r = await this.#call(mailbox, MAILBOX_TOOLS.reply, { thread_id: threadId, text });
    return parseToolResult<{ id: string }>(r);
  }
}

// ---------------------------------------------------------------------------
// In-Memory-Backend für Tests (workerd-frei).

type Store = { threads: MailboxThread[]; messages: MailboxMessage[] };

export class MemoryMailboxBackend implements MailboxBackend {
  #boxes = new Map<string, Store>();
  #seq = 0;

  seed(mailbox: string, store: Store): void {
    this.#boxes.set(mailbox, store);
  }

  #box(mailbox: string): Store {
    let s = this.#boxes.get(mailbox);
    if (!s) { s = { threads: [], messages: [] }; this.#boxes.set(mailbox, s); }
    return s;
  }

  async listThreads(mailbox: string, query?: string): Promise<MailboxThread[]> {
    const threads = this.#box(mailbox).threads;
    if (!query) return threads;
    const q = query.toLowerCase();
    return threads.filter(t => t.subject.toLowerCase().includes(q));
  }

  async getThread(mailbox: string, threadId: string): Promise<MailboxThread | null> {
    return this.#box(mailbox).threads.find(t => t.id === threadId) ?? null;
  }

  async listMessages(mailbox: string, threadId?: string): Promise<MailboxMessage[]> {
    const msgs = this.#box(mailbox).messages;
    return threadId ? msgs.filter(m => m.threadId === threadId) : msgs;
  }

  async getMessage(mailbox: string, messageId: string): Promise<MailboxMessage | null> {
    return this.#box(mailbox).messages.find(m => m.id === messageId) ?? null;
  }

  async sendMessage(mailbox: string, draft: MailboxDraft): Promise<{ id: string }> {
    const id = `msg-${++this.#seq}`;
    this.#box(mailbox).messages.push({
      id, from: mailbox, to: draft.to, subject: draft.subject, text: draft.text,
    });
    return { id };
  }

  async replyToThread(mailbox: string, threadId: string, text: string): Promise<{ id: string }> {
    const id = `msg-${++this.#seq}`;
    this.#box(mailbox).messages.push({
      id, threadId, from: mailbox, to: [], subject: "Re:", text,
    });
    return { id };
  }
}
