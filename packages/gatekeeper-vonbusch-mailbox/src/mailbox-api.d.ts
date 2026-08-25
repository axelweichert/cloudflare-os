// API-Oberfläche, die der Coding-Agent über diesen Gatekeeper sieht (Rückgabe von
// `getTypeScriptTypes()`). Bewusst auf EINE gepinnte Mailbox verengt: es gibt kein `inbox_id`-
// Argument — die Mailbox steckt im Grant, nicht im Aufruf.

/** Ein E-Mail-Thread (Konversation) in der gepinnten Mailbox. */
export interface MailboxThread {
  id: string;
  subject: string;
  /** Kurzvorschau des letzten Beitrags. */
  snippet?: string;
  /** ISO-8601-Zeitpunkt der letzten Aktivität. */
  updatedAt?: string;
}

/** Eine einzelne Nachricht in der gepinnten Mailbox. */
export interface MailboxMessage {
  id: string;
  threadId?: string;
  from: string;
  to: string[];
  subject: string;
  text: string;
  receivedAt?: string;
}

/** Entwurf einer zu sendenden Nachricht. */
export interface MailboxDraft {
  to: string[];
  subject: string;
  text: string;
}

/** Quittung einer eingereichten schreibenden Aktion. Die Wirkung folgt erst nach Human-Approval. */
export interface SubmittedAction {
  actionId: number;
  status: "pending_approval";
}

/**
 * Die RPC-Fähigkeit einer gebundenen Mailbox. Reads laufen (nach Observation-Autorisierung) sofort;
 * schreibende Aktionen (`sendMessage`, `reply`) werden zur Freigabe eingereiht und erst nach
 * Approval ausgeführt.
 */
export interface Mailbox {
  listThreads(query?: string): Promise<MailboxThread[]>;
  getThread(threadId: string): Promise<MailboxThread | null>;
  listMessages(threadId?: string): Promise<MailboxMessage[]>;
  getMessage(messageId: string): Promise<MailboxMessage | null>;
  sendMessage(draft: MailboxDraft): Promise<SubmittedAction>;
  reply(threadId: string, text: string): Promise<SubmittedAction>;
}
