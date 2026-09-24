// TypeScript interface for the owlOS MailArchiver gatekeeper. These types are exposed to gadgets
// and agents that have been granted access to a connected MailArchiver archive.
//
// owlOS MailArchiver (https://mailarchiver.owl-os.cloud) is an edge-native email archive. Like
// gatekeeper-owlos / gk-unifi / gk-cloudflare, this is a Token-Connect gatekeeper: an archive is
// connected by its base URL *plus* an `owl_…` API token created in the MailArchiver UI under
// Settings → API-Token (OWL-1686). The archive's HTTP API lives under `{baseUrl}/api`.
//
// SCOPE: READ-ONLY. The external MailArchiver API is read-only by CTO decision (OWL-1683,
// board-confirmed). An archive is, from the outside, a read object — there are no side-effecting
// actions, so every Session method is an observation.
//
// The shapes below are the camelCase structured views this connector maps the MailArchiver's
// snake_case `/api/*` JSON into (see mailarchiver-api.ts); they are not raw HTTP responses.
//
// =====================================================================================
// API CONVENTIONS
// =====================================================================================
// 1. All methods take POSITIONAL arguments. Never pass a single options object.
// 2. All methods are async and must be awaited.

/**
 * A connected owlOS MailArchiver archive, scoped to one instance + token. Read-only.
 *
 * Browsing model mirrors the MailArchiver UI: `mailboxes()` lists the archived accounts, a
 * `mailbox(id)` exposes its correspondent/date tree, and `message(id)` opens a single message.
 * `search(query)` is a full-archive text search returning summaries.
 */
export interface MailArchiverSession {
  /** Archive-wide dashboard figures (`GET /api/stats`). */
  stats(): Promise<ArchiveStats>;

  /** List the archived mailboxes (`GET /api/mailboxes`). */
  mailboxes(): Promise<Mailbox[]>;

  /** Full-text search across the whole archive; returns message summaries (`GET /api/messages?q=`). */
  search(query: string): Promise<MessageSummary[]>;

  /** Bind to one mailbox to browse its correspondent/date tree. */
  mailbox(mailboxId: string): Promise<MailboxSession>;

  /** Bind to a single archived message to read it. */
  message(messageId: string): Promise<MessageSession>;
}

/** One archived mailbox, bound for browsing its correspondents and their message tree. Read-only. */
export interface MailboxSession {
  /** Correspondents (senders/recipients) in this mailbox, each with a message count. */
  contacts(): Promise<Contact[]>;

  /**
   * Drill down the contact → year → month → day tree (`GET /api/tree/…`). `contact` is a
   * `Contact.address`; pass `year`/`month`/`day` (as strings, e.g. `"2026"`, `"09"`, `"25"`) to go
   * deeper. The reached depth determines the returned {@link MailboxTreeLevel} variant: no year →
   * years, year only → months, year+month → days, year+month+day → the day's message summaries.
   */
  messages(
    contact: string,
    year?: string,
    month?: string,
    day?: string,
  ): Promise<MailboxTreeLevel>;
}

/** A single archived message, bound for reading. Read-only. */
export interface MessageSession {
  /** Envelope + metadata: from/to/cc, subject, direction, size, ids, timestamps. */
  metadata(): Promise<MessageMetadata>;

  /** The rendered body (`GET /api/messages/:id/body`): its content type and content. */
  body(): Promise<MessageBody>;

  /** Attachment descriptors (no content). Use `attachment(id)` to fetch bytes. */
  attachments(): Promise<Attachment[]>;

  /** One attachment's bytes, base64-encoded, with its content type and filename. */
  attachment(attachmentId: string): Promise<AttachmentContent>;

  /** The raw RFC-5322 `.eml` source (for download / forwarding). */
  eml(): Promise<string>;
}

// ------------------------------------------------------------------------------------
// Data shapes (structured camelCase views over the archive — not raw HTTP responses)
// ------------------------------------------------------------------------------------

export interface ArchiveStats {
  /** Total archived messages across all mailboxes. */
  totalMessages: number;
  /** Total archived attachments across all messages. */
  totalAttachments: number;
  /** Total archive size in bytes. */
  storageBytes: number;
  /** Average archived messages per day since the first archived message. */
  avgPerDay: number;
  /** Timestamp of the oldest archived message (ISO-8601), or null if the archive is empty. */
  firstDate: string | null;
  /** Monthly message counts, oldest→newest, for a trend chart. */
  messagesOverTime: { month: string; count: number }[];
  /** The most frequent sender addresses with their message counts. */
  topSenders: { address: string; count: number }[];
  /** Inbound vs. outbound message counts across the archive. */
  directionRatio: { inbound: number; outbound: number };
  /** Per-mailbox archived-message counts, most-archived first. */
  perMailbox: { mailboxId: string; displayName: string | null; email: string; count: number }[];
}

export interface Mailbox {
  /** Stable mailbox id (use with `mailbox(id)`). */
  id: string;
  /** The mailbox's email address. */
  email: string;
  /** Human display name, if known. */
  displayName: string | null;
  /** The upstream provider this mailbox is archived from. */
  provider: "google" | "microsoft";
  /** Whether ongoing archiving is enabled for this mailbox. */
  enabled: boolean;
  /** Number of messages archived for this mailbox. */
  archivedCount: number;
  /** Timestamp of the last successful sync (ISO-8601), or null. */
  lastSyncAt: string | null;
}

export interface Contact {
  /** Email address of the correspondent (use as `MailboxSession.messages(contact)`). */
  address: string;
  /** Display name, if known. */
  name: string | null;
  /** Number of messages exchanged with this correspondent in the bound mailbox. */
  count: number;
}

export interface MessageSummary {
  /** Stable message id (use with `message(id)`). */
  id: string;
  /** Owning mailbox id. */
  mailboxId: string;
  /** `"inbound"` = received, `"outbound"` = sent. */
  direction: "inbound" | "outbound";
  /** Subject line, if any. */
  subject: string | null;
  /** Sender address. */
  fromAddress: string;
  /** Sender display name, if known. */
  fromName: string | null;
  /** Recipient addresses. */
  toAddresses: string[];
  /** Received/sent timestamp, ISO-8601. */
  receivedAt: string;
  /** Whether the message carries attachments. */
  hasAttachments: boolean;
}

export interface MessageMetadata extends MessageSummary {
  /** CC recipient addresses. */
  ccAddresses: string[];
  /** Message size in bytes, if known. */
  sizeBytes: number | null;
  /** RFC internet Message-ID header, if known. */
  internetMessageId: string | null;
  /** Provider conversation/thread id, if known. */
  conversationId: string | null;
  /** When this message was archived, ISO-8601. */
  createdAt: string;
}

export interface MessageBody {
  /** The body's content type, e.g. `text/html; charset=utf-8`. */
  contentType: string;
  /** The rendered body content. */
  content: string;
}

export interface Attachment {
  /** Attachment id (use with `attachment(id)`). */
  id: string;
  /** Original filename. */
  filename: string;
  /** MIME content type, if known. */
  mimeType: string | null;
  /** Size in bytes, if known. */
  sizeBytes: number | null;
}

export interface AttachmentContent {
  /** Original filename (from Content-Disposition, falling back to the attachment id). */
  filename: string;
  /** MIME content type, if the response carried one. */
  mimeType: string | null;
  /** Size of the downloaded bytes. */
  sizeBytes: number;
  /** Attachment bytes, base64-encoded. */
  base64: string;
}

/**
 * A level of the contact/date drill-down (`MailboxSession.messages`). The `level` discriminant says
 * which array is populated; each count bucket carries the level's own key field (`year`/`month`/`day`,
 * as returned by `GET /api/tree/…`), and the leaf level returns message summaries rather than counts.
 */
export type MailboxTreeLevel =
  | { level: "years"; years: { year: string; count: number }[] }
  | { level: "months"; months: { month: string; count: number }[] }
  | { level: "days"; days: { day: string; count: number }[] }
  | { level: "messages"; messages: MessageSummary[] };
