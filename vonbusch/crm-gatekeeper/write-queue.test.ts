// Tests für den Schreib-Freigabe-Queue-Kern (VON-1800 / K2). Workerd-frei:
//   npx tsx --test vonbusch/crm-gatekeeper/write-queue.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WriteApprovalQueue,
  MemoryWriteQueueStore,
  validateAction,
} from "./write-queue.ts";

function makeQueue() {
  let n = 0;
  let t = 0;
  return new WriteApprovalQueue(
    new MemoryWriteQueueStore(),
    {},
    () => `2026-08-25T00:00:${String(t++).padStart(2, "0")}.000Z`,
    () => `id-${++n}`,
  );
}

const GOOD_CREATE = {
  entity: "contact",
  op: "create",
  data: { name: "Erika Mustermann", email: "erika@example.com", company: "ACME" },
  proposedBy: "agent-vertrieb",
  reason: "Neuer Lead von der Messe",
};

const GOOD_UPDATE = {
  entity: "deal",
  op: "update",
  targetId: "deal-42",
  data: { stage: "won", value: 5000 },
  proposedBy: "agent-vertrieb",
};

test("validateAction akzeptiert gültiges create", () => {
  const r = validateAction(GOOD_CREATE);
  assert.ok(r.ok);
  assert.equal(r.value.entity, "contact");
  assert.equal(r.value.op, "create");
});

test("validateAction lehnt unbekannte Entity ab", () => {
  const r = validateAction({ ...GOOD_CREATE, entity: "invoice" });
  assert.ok(!r.ok);
  assert.match(r.message, /Unbekannte Entity/);
});

test("validateAction lehnt unbekannte Operation ab", () => {
  const r = validateAction({ ...GOOD_CREATE, op: "delete" });
  assert.ok(!r.ok);
  assert.match(r.message, /Unbekannte Operation/);
});

test("validateAction erzwingt Spalten-Allowlist (keine willkürlichen Felder)", () => {
  const r = validateAction({ ...GOOD_CREATE, data: { name: "X", evil_sql: "1;DROP" } });
  assert.ok(!r.ok);
  assert.match(r.message, /nicht erlaubt/);
});

test("validateAction lehnt Nicht-Primitive Werte ab", () => {
  const r = validateAction({ ...GOOD_CREATE, data: { name: { nested: true } } });
  assert.ok(!r.ok);
  assert.match(r.message, /Primitive/);
});

test("validateAction: update verlangt targetId", () => {
  const r = validateAction({ ...GOOD_UPDATE, targetId: undefined });
  assert.ok(!r.ok);
  assert.match(r.message, /targetId/);
});

test("validateAction: create verbietet targetId", () => {
  const r = validateAction({ ...GOOD_CREATE, targetId: "contact-9" });
  assert.ok(!r.ok);
  assert.match(r.message, /create darf keine targetId/);
});

test("validateAction lehnt leeres data ab", () => {
  const r = validateAction({ ...GOOD_CREATE, data: {} });
  assert.ok(!r.ok);
  assert.match(r.message, /leer/);
});

test("validateAction verlangt proposedBy", () => {
  const r = validateAction({ ...GOOD_CREATE, proposedBy: "" });
  assert.ok(!r.ok);
  assert.match(r.message, /proposedBy/);
});

test("propose legt pending Item an", async () => {
  const q = makeQueue();
  const r = await q.propose(GOOD_CREATE);
  assert.ok(r.ok);
  assert.equal(r.value.status, "pending");
  assert.equal(r.value.id, "id-1");
  assert.equal((await q.list("pending")).length, 1);
});

test("approve → markApplied Happy-Path", async () => {
  const q = makeQueue();
  const p = await q.propose(GOOD_UPDATE);
  assert.ok(p.ok);
  const d = await q.decide(p.value.id, "approve", "axel@vonbusch.digital", "passt");
  assert.ok(d.ok);
  assert.equal(d.value.status, "approved");
  assert.equal(d.value.decidedBy, "axel@vonbusch.digital");
  const a = await q.markApplied(p.value.id, "deal-42");
  assert.ok(a.ok);
  assert.equal(a.value.status, "applied");
  assert.equal(a.value.resultId, "deal-42");
});

test("reject schreibt nichts", async () => {
  const q = makeQueue();
  const p = await q.propose(GOOD_CREATE);
  assert.ok(p.ok);
  const d = await q.decide(p.value.id, "reject", "axel@vonbusch.digital");
  assert.ok(d.ok);
  assert.equal(d.value.status, "rejected");
});

test("Doppel-Entscheidung wird verhindert (kein Race/Doppel-Write)", async () => {
  const q = makeQueue();
  const p = await q.propose(GOOD_CREATE);
  assert.ok(p.ok);
  const first = await q.decide(p.value.id, "approve", "axel@vonbusch.digital");
  assert.ok(first.ok);
  const second = await q.decide(p.value.id, "approve", "jemand@vonbusch.digital");
  assert.ok(!second.ok);
  assert.match(second.message, /bereits 'approved'/);
});

test("markApplied nur für approved Items erlaubt", async () => {
  const q = makeQueue();
  const p = await q.propose(GOOD_CREATE);
  assert.ok(p.ok);
  const a = await q.markApplied(p.value.id, "x"); // noch pending
  assert.ok(!a.ok);
  assert.match(a.message, /freigegebene/);
});

test("markFailed hält Item für manuelle Prüfung", async () => {
  const q = makeQueue();
  const p = await q.propose(GOOD_UPDATE);
  assert.ok(p.ok);
  await q.decide(p.value.id, "approve", "axel@vonbusch.digital");
  const f = await q.markFailed(p.value.id, "D1 constraint failed");
  assert.ok(f.ok);
  assert.equal(f.value.status, "failed");
  assert.equal(f.value.error, "D1 constraint failed");
});

test("decide auf unbekannte ID scheitert sauber", async () => {
  const q = makeQueue();
  const d = await q.decide("nope", "approve", "axel@vonbusch.digital");
  assert.ok(!d.ok);
  assert.match(d.message, /Unbekannte/);
});

test("list gibt neueste zuerst", async () => {
  const q = makeQueue();
  await q.propose(GOOD_CREATE);
  await q.propose({ ...GOOD_CREATE, data: { name: "Zweiter" } });
  const all = await q.list();
  assert.equal(all[0].action.data.name, "Zweiter");
});
