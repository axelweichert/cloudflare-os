// Beweist das Approval-Modell des Ports (workerd-frei, tsx):
//   node --import tsx --test test/session-core.test.ts
//
//   - jede Read-Operation ruft VOR Rückgabe genau eine authorizeObservation() auf
//   - keine Read-Operation reiht eine Action ein
//   - jede schreibende Operation reiht eine Action ein (submitAction-Äquivalent) und wirkt NICHT
//     sofort auf das Backend; erst applyMailAction() sendet tatsächlich
//   - die Session trägt kein Mailbox-Argument — die Mailbox steckt im Grant

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MailboxSessionCore, applyMailAction, MAIL_OUTBOUND_KIND,
  type ObservationDescription, type ActionDescription, type PendingMailAction,
} from "../src/session-core.ts";
import { MemoryMailboxBackend } from "../src/mailbox-backend.ts";

const MAILBOX = "inbox_ceo@vonbusch.digital";

function harness() {
  const observations: ObservationDescription[] = [];
  const actions: Array<{ id: number; action: PendingMailAction; description: ActionDescription }> = [];
  const backend = new MemoryMailboxBackend();
  backend.seed(MAILBOX, {
    threads: [{ id: "t1", subject: "Angebot" }, { id: "t2", subject: "Rechnung" }],
    messages: [
      { id: "m1", threadId: "t1", from: "kunde@x.de", to: [MAILBOX], subject: "Angebot", text: "Bitte um Angebot." },
    ],
  });
  const authorizer = {
    async authorizeObservation(d: ObservationDescription) { observations.push(d); },
  };
  let seq = 0;
  const enqueuer = {
    async enqueue(action: PendingMailAction, description: ActionDescription) {
      const id = ++seq;
      actions.push({ id, action, description });
      return id;
    },
  };
  const core = new MailboxSessionCore(MAILBOX, backend, authorizer, enqueuer);
  return { core, backend, observations, actions };
}

test("listThreads liefert Daten und autorisiert genau eine Observation", async () => {
  const { core, observations, actions } = harness();
  const threads = await core.listThreads();
  assert.equal(threads.length, 2);
  assert.equal(observations.length, 1);
  assert.match(observations[0].description, /2 Thread/);
  assert.equal(observations[0].prohibitAllSharing, true);
  assert.equal(actions.length, 0, "ein Read darf keine Action einreihen");
});

test("getMessage autorisiert mit Detail und reiht keine Action ein", async () => {
  const { core, observations, actions } = harness();
  const msg = await core.getMessage("m1");
  assert.equal(msg?.from, "kunde@x.de");
  assert.equal(observations.length, 1);
  assert.match(observations[0].description, /kunde@x\.de/);
  assert.equal(actions.length, 0);
});

test("sendMessage reiht eine Action ein und wirkt NICHT sofort", async () => {
  const { core, backend, actions, observations } = harness();
  const before = await backend.listMessages(MAILBOX);
  const res = await core.sendMessage({ to: ["kunde@x.de"], subject: "Re: Angebot", text: "Anbei." });
  assert.equal(res.status, "pending_approval");
  assert.equal(res.actionId, 1);
  assert.equal(observations.length, 0, "ein Write ist keine Observation");
  assert.equal(actions.length, 1);
  assert.equal(actions[0].action.kind, "send");
  assert.equal(actions[0].description.actionKind?.tag, MAIL_OUTBOUND_KIND.tag);
  assert.equal(actions[0].description.autoApprovable, undefined, "Mailversand nie auto-approvable");
  const after = await backend.listMessages(MAILBOX);
  assert.equal(after.length, before.length, "vor Approval darf nichts gesendet sein");
});

test("applyMailAction sendet erst nach Freigabe tatsächlich", async () => {
  const { core, backend, actions } = harness();
  await core.sendMessage({ to: ["kunde@x.de"], subject: "Re", text: "Text" });
  const before = (await backend.listMessages(MAILBOX)).length;
  const receipt = await applyMailAction(MAILBOX, backend, actions[0].action);
  assert.ok(receipt.id);
  const after = (await backend.listMessages(MAILBOX)).length;
  assert.equal(after, before + 1, "nach Approval ist die Mail gesendet");
});

test("reply reiht eine reply-Action mit Thread-Bezug ein", async () => {
  const { core, actions } = harness();
  await core.reply("t1", "Danke!");
  assert.equal(actions.length, 1);
  assert.equal(actions[0].action.kind, "reply");
  assert.equal(actions[0].action.kind === "reply" && actions[0].action.threadId, "t1");
});
