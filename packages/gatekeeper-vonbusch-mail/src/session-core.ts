// vonBuschOS — Mail-Gatekeeper (K5-Port, VON-1818): transport-freier Session-Kern
//
// Bildet das Konzept-Mapping aus PORTING-GATEKEEPERVENDOR.md ab:
//   - `listProposals()` (Read) → `authorizer.authorizeObservation()` VOR Rückgabe der Daten.
//   - `proposeEmail()` (side-effecting Write) → `actions.enqueue()` (→ `ApprovalQueue.submitAction()`);
//     der eigentliche Versand über `env.EMAIL.send` tritt erst nach Approval in
//     `MailGatekeeper.applyAction()` ein.
//
// Der DO-Shell (`mail-gatekeeper.ts`) instanziiert diesen Kern mit der echten `ApprovalQueue`,
// einem persistierenden Enqueuer und einem Reader über den DO-Storage. Die Fach-Logik
// (Adress-/Allowlist-/Längen-Validierung) steckt im injizierten `validateProposal`; hier liegt nur
// das Approval-/Observation-Gerüst. Läuft workerd-frei und ist per `tsx --test` testbar.

import type { EmailProposal, QueueConfig } from "./mail-actions";
import { validateProposal } from "./mail-actions";

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

/** Eine bereits validierte, versandfertige Mail, die der DO persistiert. */
export type PendingEmail = EmailProposal;

/** Reiht eine Sende-Aktion zur Freigabe ein und liefert die vom Gatekeeper vergebene Aktions-ID. */
export interface ActionEnqueuer {
  enqueue(email: PendingEmail, description: ActionDescription): Promise<number>;
}

/** Statusansicht eines Vorschlags für die read-only `listProposals()`-Observation. */
export type ProposalView = {
  actionId: number;
  to: string;
  from: string;
  subject: string;
  status: "pending" | "sent" | "failed";
  proposedBy: string;
  error?: string;
};

/** Liefert die im DO gespeicherten Vorschläge (Audit/Status). */
export interface ProposalReader {
  listProposals(): Promise<ProposalView[]>;
}

/** Quittung einer eingereichten Sende-Aktion; die Wirkung folgt erst nach Human-Approval. */
export type SubmittedAction = { actionId: number; status: "pending_approval" };

/** Der Eingabe-Umschlag für einen Mail-Vorschlag (`from` optional → Standardabsender). */
export type ProposeEmailInput = {
  to: string;
  subject: string;
  text: string;
  /** Absender (optional; muss auf der Allowlist stehen). */
  from?: string;
  /** Kurze Begründung für den freigebenden Menschen. */
  reason?: string;
};

/**
 * Stabiler Action-Kind-Tag für ausgehende Mails. Auto-Approval ist NICHT vorgesehen (jeder Versand
 * ist ein extern sichtbarer Seiteneffekt) — der Gatekeeper meldet `getAutoApprovableActions()` leer
 * und setzt `autoApprovable` nie.
 */
export const MAIL_SEND_KIND: ActionKind = { tag: "vonbusch.mail.send", label: "E-Mail versenden" };

/** Kürzt lange Bodies für die menschenlesbare Approval-Beschreibung. */
function preview(text: string, max = 500): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max) + "…" : oneLine;
}

/**
 * Die RPC-Fähigkeit, die dem Gadget übergeben wird. `listProposals` läuft (nach Observation-
 * Autorisierung) sofort; `proposeEmail` wird zur Freigabe eingereiht und erst nach Approval
 * versendet.
 */
export class MailSessionCore {
  constructor(
    private readonly config: QueueConfig,
    private readonly authorizer: ObservationAuthorizer,
    private readonly actions: ActionEnqueuer,
    private readonly reader: ProposalReader,
    /** Standardabsender, falls der Vorschlag kein `from` trägt. */
    private readonly defaultFrom: string,
    /** Identität des gebundenen Gadgets/Accounts — landet als `proposedBy` an jeder Aktion. */
    private readonly proposedBy: string,
  ) {}

  // --- Write: validieren + einreihen, NICHT versenden. ---

  async proposeEmail(input: ProposeEmailInput): Promise<SubmittedAction> {
    const from = (typeof input?.from === "string" && input.from.trim()) ? input.from.trim() : this.defaultFrom;
    const validated = validateProposal(
      {
        to: input?.to,
        from,
        subject: input?.subject,
        text: input?.text,
        proposedBy: this.proposedBy,
        reason: input?.reason,
      },
      this.config,
    );
    if (!validated.ok) {
      // Ungültige Vorschläge werden gar nicht erst eingereiht — der Fehler geht ans Gadget zurück.
      throw new Error(validated.message);
    }
    const email = validated.value;
    const actionId = await this.actions.enqueue(email, {
      title: `E-Mail an ${email.to} senden`,
      description:
        "Vorschlag, eine E-Mail zu versenden:\n\n" +
        `- **An:** ${email.to}\n` +
        `- **Von:** ${email.from}\n` +
        `- **Betreff:** ${email.subject}\n\n` +
        `${preview(email.text)}` +
        (email.reason ? `\n\n**Begründung:** ${email.reason}` : ""),
      implementsRevert: false,
      awaitDecision: true,
      actionKind: MAIL_SEND_KIND,
    });
    return { actionId, status: "pending_approval" };
  }

  // --- Read: Vorschläge holen, DANN autorisieren, DANN zurückgeben. ---

  async listProposals(): Promise<ProposalView[]> {
    const all = await this.reader.listProposals();
    // Der Agent sieht nur seine eigenen Vorschläge (wie das Ursprungs-Tool `list_my_proposals`).
    const mine = all.filter((p) => p.proposedBy === this.proposedBy);
    await this.authorizer.authorizeObservation({
      title: "Eigene E-Mail-Vorschläge auflisten",
      description: `Liest ${mine.length} eigene(n) E-Mail-Vorschlag/Vorschläge mit aktuellem Status.`,
      prohibitAllSharing: true,
    });
    return mine;
  }
}
