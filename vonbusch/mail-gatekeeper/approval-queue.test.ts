// Tests für den Approval-Queue-Kern (VON-1802 / K5). Workerd-frei:
//   node --import tsx --test vonbusch/mail-gatekeeper/approval-queue.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MailApprovalQueue,
  MemoryQueueStore,
  validateProposal,
  isEmail,
  type QueueConfig,
} from "./approval-queue.ts";

const CONFIG: QueueConfig = { allowedFrom: ["noreply@vonbusch.app"] };

function makeQueue() {
  let n = 0;
  let t = 0;
  return new MailApprovalQueue(
    new MemoryQueueStore(),
    CONFIG,
    () => `2026-08-25T00:00:${String(t++).padStart(2, "0")}.000Z`,
    () => `id-${++n}`,
  );
}

const GOOD = {
  to: "kunde@example.com",
  from: "noreply@vonbusch.app",
  subject: "Angebot",
  text: "Guten Tag,\nanbei Ihr Angebot.",
  proposedBy: "agent-crm",
  reason: "Follow-up nach Anfrage",
};

test("isEmail akzeptiert gültige und lehnt ungültige Adressen ab", () => {
  assert.ok(isEmail("a@b.de"));
  assert.ok(!isEmail("kein-email"));
  assert.ok(!isEmail("a@b"));
  assert.ok(!isEmail(42));
});

test("validateProposal erzwingt Absender-Allowlist", () => {
  const bad = validateProposal({ ...GOOD, from: "fremd@evil.com" }, CONFIG);
  assert.ok(!bad.ok);
  assert.match(bad.message, /Allowlist/);
});

test("validateProposal blockt Header-Injection im Betreff", () => {
  const bad = validateProposal({ ...GOOD, subject: "Hi\r\nBcc: victim@x.com" }, CONFIG);
  assert.ok(!bad.ok);
  assert.match(bad.message, /Zeilenumbrüche/);
});

test("validateProposal verlangt Pflichtfelder", () => {
  assert.ok(!validateProposal({ ...GOOD, to: "" }, CONFIG).ok);
  assert.ok(!validateProposal({ ...GOOD, subject: "" }, CONFIG).ok);
  assert.ok(!validateProposal({ ...GOOD, text: "  " }, CONFIG).ok);
  assert.ok(!validateProposal({ ...GOOD, proposedBy: "" }, CONFIG).ok);
});

test("propose legt pending Item an", async () => {
  const q = makeQueue();
  const r = await q.propose(GOOD);
  assert.ok(r.ok);
  assert.equal(r.value.status, "pending");
  assert.equal(r.value.id, "id-1");
  const list = await q.list("pending");
  assert.equal(list.length, 1);
});

test("approve → markSent Happy-Path", async () => {
  const q = makeQueue();
  const p = await q.propose(GOOD);
  assert.ok(p.ok);
  const d = await q.decide(p.value.id, "approve", "axel@vonbusch.digital", "sieht gut aus");
  assert.ok(d.ok);
  assert.equal(d.value.status, "approved");
  assert.equal(d.value.decidedBy, "axel@vonbusch.digital");
  const s = await q.markSent(p.value.id, "msg-123");
  assert.ok(s.ok);
  assert.equal(s.value.status, "sent");
  assert.equal(s.value.sentMessageId, "msg-123");
});

test("reject setzt Status ohne Versand", async () => {
  const q = makeQueue();
  const p = await q.propose(GOOD);
  assert.ok(p.ok);
  const d = await q.decide(p.value.id, "reject", "axel@vonbusch.digital");
  assert.ok(d.ok);
  assert.equal(d.value.status, "rejected");
});

test("Doppel-Entscheidung wird verhindert (kein Race/Doppel-Send)", async () => {
  const q = makeQueue();
  const p = await q.propose(GOOD);
  assert.ok(p.ok);
  const first = await q.decide(p.value.id, "approve", "axel@vonbusch.digital");
  assert.ok(first.ok);
  const second = await q.decide(p.value.id, "approve", "jemand@vonbusch.digital");
  assert.ok(!second.ok);
  assert.match(second.message, /bereits 'approved'/);
});

test("markSent nur für approved Items erlaubt", async () => {
  const q = makeQueue();
  const p = await q.propose(GOOD);
  assert.ok(p.ok);
  const s = await q.markSent(p.value.id, "x"); // noch pending
  assert.ok(!s.ok);
  assert.match(s.message, /freigegebene/);
});

test("decide auf unbekannte ID scheitert sauber", async () => {
  const q = makeQueue();
  const d = await q.decide("nope", "approve", "axel@vonbusch.digital");
  assert.ok(!d.ok);
  assert.match(d.message, /Unbekannte/);
});

test("markFailed hält Item für manuelle Prüfung", async () => {
  const q = makeQueue();
  const p = await q.propose(GOOD);
  assert.ok(p.ok);
  await q.decide(p.value.id, "approve", "axel@vonbusch.digital");
  const f = await q.markFailed(p.value.id, "SMTP 550");
  assert.ok(f.ok);
  assert.equal(f.value.status, "failed");
  assert.equal(f.value.error, "SMTP 550");
});

test("list gibt neueste zuerst", async () => {
  const q = makeQueue();
  await q.propose(GOOD);
  await q.propose({ ...GOOD, subject: "Zweite" });
  const all = await q.list();
  assert.equal(all[0].proposal.subject, "Zweite");
});
