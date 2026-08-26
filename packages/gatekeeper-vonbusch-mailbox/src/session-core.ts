// Transport-freier Kern der Mailbox-Gatekeeper-Session (workerd-frei, tsx-testbar).
//
// Bildet das Konzept-Mapping aus PORTING-GATEKEEPERVENDOR.md ab:
//   - jede Read-Operation → `authorizer.authorizeObservation()` VOR Rückgabe der Daten
//   - jede schreibende Mail-Aktion → `actions.enqueue()` (→ `ApprovalQueue.submitAction()`); die
//     eigentliche Wirkung tritt erst nach Approval in `MailboxGatekeeper.applyAction()` ein.
//
// Der DO-Shell (`mailbox-gatekeeper.ts`) instanziiert diesen Kern mit der echten `ApprovalQueue`
// und einem persistierenden Enqueuer. Die Fach-Logik (Datenzugriff, Pin-Verengung) steckt im
// injizierten `MailboxBackend`; hier liegt nur das Approval-/Observation-Gerüst.

import type { MailboxBackend, MailboxThread, MailboxMessage, MailboxDraft } from "./mailbox-backend";

/** Teilmenge von `@gadgets/workshop-shared` — lokal definiert, damit der Kern tsx-testbar bleibt. */
export type ObservationDescription = { title: string; description: string; prohibitAllSharing?: boolean };
export type ActionKind = { tag: string; label: string };
export type ActionDescription = {
  title: string;
  description: string;
  implementsRevert: boolean;
  awaitDecision?: boolean;
  autoApprovable?: boolean;
  actionKind?: ActionKind;
};

/** Was der Kern zum Autorisieren einer Beobachtung braucht (strukturell = `ObservationAuthorizer`). */
export interface ObservationAuthorizer {
  authorizeObservation(description: ObservationDescription): Promise<void>;
}

/** Eine noch nicht angewandte schreibende Mail-Aktion, die der DO persistiert. */
export type PendingMailAction =
  | { kind: "send"; draft: MailboxDraft }
  | { kind: "reply"; threadId: string; text: string };

/** Reiht eine Aktion zur Freigabe ein und liefert die vom Gatekeeper vergebene Aktions-ID. */
export interface ActionEnqueuer {
  enqueue(action: PendingMailAction, description: ActionDescription): Promise<number>;
}

/** Ergebnis einer eingereichten schreibenden Aktion (die Wirkung folgt erst nach Approval). */
export type SubmittedAction = {
  actionId: number;
  status: "pending_approval";
};

/**
 * Stabiler Action-Kind-Tag für ausgehende Mail. Auto-Approval ist für diesen Tag NICHT vorgesehen
 * (Mailversand kann Daten nach außen tragen) — der Gatekeeper meldet `getAutoApprovableActions()`
 * daher leer und setzt `autoApprovable` nie.
 */
export const MAIL_OUTBOUND_KIND: ActionKind = { tag: "vonbusch.mailbox.outbound", label: "E-Mail senden" };

/**
 * Die RPC-Fähigkeit, die dem Gadget übergeben wird. Alle Operationen sind fest auf `mailbox`
 * verengt — es gibt bewusst KEIN Mailbox-Argument in der öffentlichen Signatur.
 */
export class MailboxSessionCore {
  constructor(
    private readonly mailbox: string,
    private readonly backend: MailboxBackend,
    private readonly authorizer: ObservationAuthorizer,
    private readonly actions: ActionEnqueuer,
  ) {}

  // --- Reads: Daten holen, DANN autorisieren, DANN zurückgeben. ---

  async listThreads(query?: string): Promise<MailboxThread[]> {
    const threads = await this.backend.listThreads(this.mailbox, query);
    await this.authorizer.authorizeObservation({
      title: `Threads in ${this.mailbox} auflisten`,
      description:
        `Liest ${threads.length} Thread(s) aus der Mailbox \`${this.mailbox}\`` +
        (query ? ` (Suche: \`${query}\`)` : "") + ".",
      prohibitAllSharing: true,
    });
    return threads;
  }

  async getThread(threadId: string): Promise<MailboxThread | null> {
    const thread = await this.backend.getThread(this.mailbox, threadId);
    await this.authorizer.authorizeObservation({
      title: `Thread ${threadId} lesen`,
      description: `Liest den Thread \`${threadId}\` (Betreff: ${thread?.subject ?? "—"}) aus \`${this.mailbox}\`.`,
      prohibitAllSharing: true,
    });
    return thread;
  }

  async listMessages(threadId?: string): Promise<MailboxMessage[]> {
    const messages = await this.backend.listMessages(this.mailbox, threadId);
    await this.authorizer.authorizeObservation({
      title: `Nachrichten in ${this.mailbox} auflisten`,
      description:
        `Liest ${messages.length} Nachricht(en) aus \`${this.mailbox}\`` +
        (threadId ? ` (Thread \`${threadId}\`)` : "") + ".",
      prohibitAllSharing: true,
    });
    return messages;
  }

  async getMessage(messageId: string): Promise<MailboxMessage | null> {
    const message = await this.backend.getMessage(this.mailbox, messageId);
    await this.authorizer.authorizeObservation({
      title: `Nachricht ${messageId} lesen`,
      description:
        `Liest Nachricht \`${messageId}\`` +
        (message ? ` von ${message.from} (Betreff: ${message.subject})` : "") + ` aus \`${this.mailbox}\`.`,
      prohibitAllSharing: true,
    });
    return message;
  }

  // --- Writes: einreihen, nicht ausführen. ---

  async sendMessage(draft: MailboxDraft): Promise<SubmittedAction> {
    const actionId = await this.actions.enqueue(
      { kind: "send", draft },
      {
        title: `E-Mail an ${draft.to.join(", ")}`,
        description:
          `Sendet aus \`${this.mailbox}\` eine E-Mail an **${draft.to.join(", ")}**.\n\n` +
          `**Betreff:** ${draft.subject}\n\n${draft.text}`,
        implementsRevert: false,
        awaitDecision: true,
        actionKind: MAIL_OUTBOUND_KIND,
      },
    );
    return { actionId, status: "pending_approval" };
  }

  async reply(threadId: string, text: string): Promise<SubmittedAction> {
    const actionId = await this.actions.enqueue(
      { kind: "reply", threadId, text },
      {
        title: `Antwort in Thread ${threadId}`,
        description: `Antwortet in Thread \`${threadId}\` aus \`${this.mailbox}\`:\n\n${text}`,
        implementsRevert: false,
        awaitDecision: true,
        actionKind: MAIL_OUTBOUND_KIND,
      },
    );
    return { actionId, status: "pending_approval" };
  }
}

/** Wendet eine (freigegebene) Aktion tatsächlich auf das Backend an. Aufgerufen aus `applyAction()`. */
export async function applyMailAction(
  mailbox: string,
  backend: MailboxBackend,
  action: PendingMailAction,
): Promise<{ id: string }> {
  switch (action.kind) {
    case "send":
      return backend.sendMessage(mailbox, action.draft);
    case "reply":
      return backend.replyToThread(mailbox, action.threadId, action.text);
  }
}
