// Agent-facing API for the Microsoft 365 (Outlook) gatekeeper.
//
// Phase 1 is read-only: it exposes the connected account's mail, calendar, and To Do tasks
// through Microsoft Graph v1.0. Writing (send mail, create events/tasks) is a later phase.

/** The connected Microsoft 365 account. */
export interface M365Profile {
  /** The account's object id in the directory. */
  id: string;
  /** Display name, e.g. "Axel Weichert". */
  displayName: string | null;
  /** Primary email / User Principal Name, e.g. "axel@weichert.at". */
  email: string | null;
  /** Job title, if set in the directory. */
  jobTitle: string | null;
}

/** A mail address with an optional display name. */
export interface M365EmailAddress {
  name: string | null;
  address: string | null;
}

/** A summary of a mail message, as returned by list operations. */
export interface M365MessageSummary {
  /** Stable Graph message id; pass to {@link M365Session.getMessage}. */
  id: string;
  /** Conversation (thread) id this message belongs to. */
  conversationId: string | null;
  subject: string | null;
  /** Short plain-text preview of the body. */
  preview: string;
  from: M365EmailAddress | null;
  toRecipients: M365EmailAddress[];
  /** ISO 8601 timestamp the message was received. */
  receivedDateTime: string | null;
  isRead: boolean;
  hasAttachments: boolean;
  /** Deep link to open the message in Outlook on the web. */
  webLink: string | null;
}

/** A full mail message including its body. */
export interface M365Message extends M365MessageSummary {
  ccRecipients: M365EmailAddress[];
  /** Body content, either plain text or HTML — see {@link M365Message.bodyContentType}. */
  body: string;
  bodyContentType: "text" | "html";
}

/** A single calendar event. */
export interface M365Event {
  /** Stable Graph event id; pass to {@link M365Session.getEvent}. */
  id: string;
  subject: string | null;
  /** ISO 8601 start timestamp. */
  start: string | null;
  /** ISO 8601 end timestamp. */
  end: string | null;
  /** IANA time zone the start/end are expressed in (e.g. "Europe/Vienna"). */
  timeZone: string | null;
  isAllDay: boolean;
  location: string | null;
  organizer: M365EmailAddress | null;
  attendees: M365EmailAddress[];
  /** Short plain-text preview of the body. */
  preview: string;
  /** Whether this is a recurring event (any instance/series). */
  isRecurring: boolean;
  /** Deep link to open the event in Outlook on the web. */
  webLink: string | null;
}

/** A Microsoft To Do task list. */
export interface M365TaskList {
  /** Stable id; pass to {@link M365Session.listTasks}. */
  id: string;
  displayName: string;
  /** Whether this is the account's built-in default list ("Tasks"). */
  isDefault: boolean;
}

/** A single Microsoft To Do task. */
export interface M365Task {
  id: string;
  title: string;
  /** "notStarted" | "inProgress" | "completed" | "waitingOnOthers" | "deferred". */
  status: string;
  /** "low" | "normal" | "high". */
  importance: string;
  /** ISO 8601 due date, if set. */
  dueDateTime: string | null;
  /** Short plain-text preview of the task body/notes. */
  preview: string;
  isCompleted: boolean;
}

/** Options for {@link M365Session.listMessages}. */
export interface M365ListMessagesOptions {
  /** Mail folder well-known name (e.g. "inbox", "sentitems", "drafts"). Defaults to "inbox". */
  folder?: string;
  /** Max messages to return (1–50, default 25). */
  top?: number;
  /** Free-text search across the message ($search). Mutually exclusive with folder ordering. */
  search?: string;
}

/** Options for {@link M365Session.listEvents}. */
export interface M365ListEventsOptions {
  /** Max events to return (1–50, default 25). */
  top?: number;
  /** ISO 8601 lower bound (inclusive) for the event window; defaults to now. */
  startDateTime?: string;
  /** ISO 8601 upper bound (exclusive) for the event window; defaults to 30 days out. */
  endDateTime?: string;
}

/**
 * Read-only access to a connected Microsoft 365 (Outlook) account: mail, calendar, and To Do tasks.
 *
 * All methods surface a small, agent-friendly projection of Microsoft Graph. Timestamps are ISO
 * 8601 strings. Ids are opaque Graph ids — pass them back to the corresponding get/list method.
 */
export interface M365Session {
  /** Read the connected account's profile (name, email, job title). */
  getProfile(): Promise<M365Profile>;

  /**
   * List messages in a mail folder (default "inbox"), most recent first. Returns summaries only;
   * call {@link getMessage} for the full body.
   */
  listMessages(options?: M365ListMessagesOptions): Promise<M365MessageSummary[]>;

  /** Read a single message, including its body, by id. */
  getMessage(id: string): Promise<M365Message>;

  /**
   * List calendar events in a time window (default: now through 30 days out), ordered by start.
   * Recurring series are expanded into instances within the window.
   */
  listEvents(options?: M365ListEventsOptions): Promise<M365Event[]>;

  /** Read a single calendar event by id. */
  getEvent(id: string): Promise<M365Event>;

  /** List the account's Microsoft To Do task lists. */
  listTaskLists(): Promise<M365TaskList[]>;

  /**
   * List tasks in a To Do list. Pass a list id from {@link listTaskLists}.
   * @param top Max tasks to return (1–100, default 50).
   */
  listTasks(listId: string, top?: number): Promise<M365Task[]>;
}
