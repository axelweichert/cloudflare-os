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
// =====================================================================================
// API CONVENTIONS
// =====================================================================================
// 1. All methods take POSITIONAL arguments. Never pass a single options object
//    (SearchQuery is the one structured filter argument, per capnweb plain-object support).
// 2. All methods are async and must be awaited.

/**
 * A connected owlOS MailArchiver archive, scoped to one instance + token. Read-only.
 *
 * Resource granularities (getGatekeeperClassFor):
 *  - whole archive  `https://mailarchiver.owl-os.cloud`            → MailArchiverSession
 *  - single mailbox `https://mailarchiver.owl-os.cloud?mailbox=ID` → MailboxSession
 */
export interface MailArchiverSession {
  /** Archive key figures: total messages, mailbox count, total size, last sync time. */
  stats(): Promise<ArchiveStats>;

  /** List the archived mailboxes. */
  mailboxes(): Promise<Mailbox[]>;

  /**
   * Full-text + faceted search across the whole archive. Results are summaries; use
   * `message(id)` to open a hit. Returns at most `query.limit` (default 50, max 200) rows.
   */
  search(query: SearchQuery): Promise<MessageSummary[]>;

  /** Bind to one mailbox to browse its correspondent tree. Throws if `mailboxId` is unknown. */
  mailbox(mailboxId: string): Promise<MailboxSession>;

  /** Bind to a single archived message. Throws if `messageId` is unknown. */
  message(messageId: string): Promise<MessageSession>;
}

/** One archived mailbox, bound for browsing its correspondents. Read-only. */
export interface MailboxSession {
  /** Correspondents (senders/recipients) in this mailbox, each with a message count. */
  contacts(): Promise<Contact[]>;

  /**
   * Messages exchanged with one correspondent, optionally narrowed to a year / month / day.
   * `contact` is a `Contact.address`. Returns summaries; open a hit with `MailArchiverSession.message(id)`.
   */
  messages(contact: string, year?: number, month?: number, day?: number): Promise<MessageSummary[]>;
}

/** A single archived message, bound for reading. Read-only. */
export interface MessageSession {
  /** Envelope + metadata: from/to, subject, date, folder, direction, size, attachment flag. */
  metadata(): Promise<MessageMeta>;

  /** Rendered body. `html` is sanitized display HTML; `text` is the plain-text alternative. */
  body(): Promise<MessageBody>;

  /** Attachment descriptors (no content). Use `attachment(id)` to fetch bytes. */
  attachments(): Promise<Attachment[]>;

  /** One attachment's bytes, base64-encoded, with its content type and filename. */
  attachment(attachmentId: string): Promise<AttachmentContent>;

  /** The raw RFC-5322 `.eml` source, base64-encoded (for download / forwarding). */
  eml(): Promise<string>;
}

// ------------------------------------------------------------------------------------
// Filter
// ------------------------------------------------------------------------------------

export interface SearchQuery {
  /** Full-text query (matches subject + body + participants). Omit to list by filters only. */
  q?: string;
  /** Restrict to one mailbox id. */
  mailboxId?: string;
  /** `"in"` = received, `"out"` = sent. */
  direction?: "in" | "out";
  /** ISO date (`YYYY-MM-DD`); keep only messages with `date >=` this. */
  from?: string;
  /** ISO date (`YYYY-MM-DD`); keep only messages with `date <=` this. */
  to?: string;
  /** Page size, default 50, max 200. */
  limit?: number;
  /** Row offset for paging, default 0. */
  offset?: number;
}

// ------------------------------------------------------------------------------------
// Data shapes (structured views over the archive — not raw HTTP responses)
// ------------------------------------------------------------------------------------

export interface ArchiveStats {
  /** Total archived messages across all mailboxes. */
  totalMessages: number;
  /** Number of archived mailboxes. */
  mailboxCount: number;
  /** Total archive size in bytes (sum of message sizes). */
  totalSizeBytes: number;
  /** Timestamp of the most recently archived message, ISO-8601, or null if empty. */
  lastMessageAt: string | null;
}

export interface Mailbox {
  /** Stable mailbox id (use with `mailbox(id)` / `SearchQuery.mailboxId`). */
  id: string;
  /** The mailbox's email address. */
  email: string;
  /** Human display name, if known. */
  name: string | null;
  /** Number of messages archived for this mailbox. */
  messageCount: number;
}

export interface Contact {
  /** Email address of the correspondent (use as `MailboxSession.messages(contact)`). */
  address: string;
  /** Display name, if known. */
  name: string | null;
  /** Number of messages exchanged with this correspondent in the bound mailbox. */
  messageCount: number;
}

export interface MessageSummary {
  /** Stable message id (use with `message(id)`). */
  id: string;
  /** Sender address. */
  from: string;
  /** Recipient addresses. */
  to: string[];
  /** Subject line. */
  subject: string;
  /** Received/sent timestamp, ISO-8601. */
  date: string;
  /** `"in"` = received, `"out"` = sent. */
  direction: "in" | "out";
  /** Whether the message carries attachments. */
  hasAttachments: boolean;
}

export interface MessageMeta extends MessageSummary {
  /** CC recipient addresses. */
  cc: string[];
  /** Source folder/label in the origin mailbox. */
  folder: string | null;
  /** Owning mailbox id. */
  mailboxId: string;
  /** Message size in bytes. */
  sizeBytes: number;
  /** RFC Message-ID header. */
  messageId: string | null;
}

export interface MessageBody {
  /** Sanitized display HTML, if the message had an HTML part. */
  html: string | null;
  /** Plain-text body, if present. */
  text: string | null;
}

export interface Attachment {
  /** Attachment id (use with `attachment(id)`). */
  id: string;
  /** Original filename. */
  filename: string;
  /** MIME content type. */
  contentType: string;
  /** Size in bytes. */
  sizeBytes: number;
}

export interface AttachmentContent extends Attachment {
  /** Attachment bytes, base64-encoded. */
  base64: string;
}
