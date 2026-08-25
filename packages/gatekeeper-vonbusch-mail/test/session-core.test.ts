// vonBuschOS — Mail-Gatekeeper (K5-Port, VON-1818): Tests für das Approval-/Observation-Gerüst.
// Injiziert Fake-ApprovalQueue + Fake-Enqueuer + Fake-Reader; workerd-frei.
// node --import tsx --test test/session-core.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MailSessionCore,
  MAIL_SEND_KIND,
  type ActionDescription,
  type ObservationDescription,
  type PendingEmail,
  type ProposalView,
} from "../src/session-core.ts";
import type { QueueConfig } from "../src/mail-actions.ts";

const CONFIG: QueueConfig = { allowedFrom: ["noreply@vonbusch.app"] };
const DEFAULT_FROM = "noreply@vonbusch.app";
const ACCOUNT = "acct-1";

/** Fake-Authorizer, der die Observations mitschreibt. */
class RecordingAuthorizer {
  public observed: ObservationDescription[] = [];
  async authorizeObservation(d: ObservationDescription): Promise<void> {
    this.observed.push(d);
  }
}

/** Fake-Enqueuer, der die eingereihten Aktionen mitschreibt und IDs vergibt. */
class RecordingEnqueuer {
  public queued: { email: PendingEmail; description: ActionDescription }[] = [];
  async enqueue(email: PendingEmail, description: ActionDescription): Promise<number> {
    this.queued.push({ email, description });
    return this.queued.length; // 1-basierte IDs
  }
}

function makeCore(reader: { listProposals(): Promise<ProposalView[]> } = { listProposals: async () => [] }) {
  const authorizer = new RecordingAuthorizer();
  const enqueuer = new RecordingEnqueuer();
  const core = new MailSessionCore(CONFIG, authorizer, enqueuer, reader, DEFAULT_FROM, ACCOUNT);
  return { core, authorizer, enqueuer };
}

test("proposeEmail reiht ein (submitAction-Pfad) und versendet NICHT direkt", async () => {
  const { core, enqueuer } = makeCore();
  const res = await core.proposeEmail({
    to: "kunde@example.com",
    subject: "Angebot",
    text: "Anbei Ihr Angebot.",
    reason: "Follow-up",
  });
  assert.deepEqual(res, { actionId: 1, status: "pending_approval" });
  assert.equal(enqueuer.queued.length, 1);
  const q = enqueuer.queued[0];
  assert.equal(q.email.from, DEFAULT_FROM); // Standardabsender eingesetzt
  assert.equal(q.email.proposedBy, ACCOUNT);
  assert.equal(q.description.awaitDecision, true);
  assert.equal(q.description.implementsRevert, false);
  assert.deepEqual(q.description.actionKind, MAIL_SEND_KIND);
  assert.match(q.description.description, /Follow-up/);
});

test("proposeEmail respektiert explizites (allowlistetes) from", async () => {
  const { core, enqueuer } = makeCore();
  await core.proposeEmail({
    to: "kunde@example.com",
    from: "noreply@vonbusch.app",
    subject: "Hi",
    text: "Text",
  });
  assert.equal(enqueuer.queued[0].email.from, "noreply@vonbusch.app");
});

test("proposeEmail wirft bei ungültigem Vorschlag und reiht NICHTS ein", async () => {
  const { core, enqueuer } = makeCore();
  await assert.rejects(
    core.proposeEmail({ to: "kein-email", subject: "x", text: "y" }),
    /gültige E-Mail-Adresse/,
  );
  await assert.rejects(
    core.proposeEmail({ to: "kunde@example.com", from: "fremd@evil.com", subject: "x", text: "y" }),
    /Allowlist/,
  );
  assert.equal(enqueuer.queued.length, 0);
});

test("listProposals autorisiert die Observation VOR Rückgabe und filtert auf eigene", async () => {
  const rows: ProposalView[] = [
    { actionId: 2, to: "a@x.de", from: DEFAULT_FROM, subject: "S2", status: "pending", proposedBy: ACCOUNT },
    { actionId: 1, to: "b@x.de", from: DEFAULT_FROM, subject: "S1", status: "sent", proposedBy: "anderer" },
  ];
  const { core, authorizer } = makeCore({ listProposals: async () => rows });
  const out = await core.listProposals();
  assert.equal(out.length, 1);
  assert.equal(out[0].actionId, 2);
  assert.equal(authorizer.observed.length, 1);
  assert.equal(authorizer.observed[0].prohibitAllSharing, true);
});
