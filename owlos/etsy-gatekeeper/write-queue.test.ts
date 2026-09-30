// Tests fuer den Schreib-Freigabe-Queue-Kern (OWL-1740). Workerd-frei:
//   npx tsx --test owlos/etsy-gatekeeper/write-queue.test.ts

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
    () => `2026-09-30T00:00:${String(t++).padStart(2, "0")}.000Z`,
    () => `id-${++n}`,
  );
}

const GOOD_LISTING = {
  target: "listing",
  op: "update",
  targetId: "1234567890",
  data: { state: "inactive", title: "Handgemachte Keramikvase" },
  proposedBy: "agent-shop",
  reason: "Saisonende — pausieren",
};

const GOOD_RECEIPT = {
  target: "receipt",
  op: "update",
  targetId: "998877",
  data: { was_shipped: true },
  proposedBy: "agent-shop",
};

test("validateAction akzeptiert gueltiges listing update", () => {
  const r = validateAction(GOOD_LISTING);
  assert.ok(r.ok);
  assert.equal(r.value.target, "listing");
  assert.equal(r.value.op, "update");
  assert.equal(r.value.targetId, "1234567890");
});

test("validateAction akzeptiert gueltiges receipt update", () => {
  const r = validateAction(GOOD_RECEIPT);
  assert.ok(r.ok);
  assert.equal(r.value.data.was_shipped, true);
});

test("validateAction lehnt unbekanntes Ziel ab", () => {
  const r = validateAction({ ...GOOD_LISTING, target: "coupon" });
  assert.ok(!r.ok);
  assert.match(r.message, /Unbekanntes Ziel/);
});

test("validateAction lehnt andere Operation als update ab", () => {
  const r = validateAction({ ...GOOD_LISTING, op: "create" });
  assert.ok(!r.ok);
  assert.match(r.message, /Unbekannte Operation/);
});

test("validateAction erzwingt Feld-Allowlist (keine willkuerlichen Felder)", () => {
  const r = validateAction({ ...GOOD_LISTING, data: { price: 9999 } });
  assert.ok(!r.ok);
  assert.match(r.message, /nicht erlaubt/);
});

test("validateAction erzwingt Enum bei listing.state", () => {
  const r = validateAction({ ...GOOD_LISTING, data: { state: "deleted" } });
  assert.ok(!r.ok);
  assert.match(r.message, /state.*muss einer von/);
});

test("validateAction erzwingt Typ (was_shipped muss boolean sein)", () => {
  const r = validateAction({ ...GOOD_RECEIPT, data: { was_shipped: "ja" } });
  assert.ok(!r.ok);
  assert.match(r.message, /boolean/);
});

test("validateAction lehnt Nicht-Primitive Werte ab", () => {
  const r = validateAction({ ...GOOD_LISTING, data: { title: { nested: true } } });
  assert.ok(!r.ok);
  assert.match(r.message, /Primitive/);
});

test("validateAction: update verlangt targetId", () => {
  const r = validateAction({ ...GOOD_LISTING, targetId: undefined });
  assert.ok(!r.ok);
  assert.match(r.message, /targetId/);
});

test("validateAction: targetId muss numerisch sein", () => {
  const r = validateAction({ ...GOOD_LISTING, targetId: "abc; DROP" });
  assert.ok(!r.ok);
  assert.match(r.message, /numerische Etsy-ID/);
});

test("validateAction lehnt leeres data ab", () => {
  const r = validateAction({ ...GOOD_LISTING, data: {} });
  assert.ok(!r.ok);
  assert.match(r.message, /leer/);
});

test("validateAction verlangt proposedBy", () => {
  const r = validateAction({ ...GOOD_LISTING, proposedBy: "" });
  assert.ok(!r.ok);
  assert.match(r.message, /proposedBy/);
});

test("propose legt pending Item an", async () => {
  const q = makeQueue();
  const r = await q.propose(GOOD_LISTING);
  assert.ok(r.ok);
  assert.equal(r.value.status, "pending");
  assert.equal(r.value.id, "id-1");
  assert.equal((await q.list("pending")).length, 1);
});

test("approve → markApplied Happy-Path", async () => {
  const q = makeQueue();
  const p = await q.propose(GOOD_RECEIPT);
  assert.ok(p.ok);
  const d = await q.decide(p.value.id, "approve", "axel@weichert.at", "passt");
  assert.ok(d.ok);
  assert.equal(d.value.status, "approved");
  assert.equal(d.value.decidedBy, "axel@weichert.at");
  const a = await q.markApplied(p.value.id, "998877");
  assert.ok(a.ok);
  assert.equal(a.value.status, "applied");
  assert.equal(a.value.resultId, "998877");
});

test("reject schreibt nichts", async () => {
  const q = makeQueue();
  const p = await q.propose(GOOD_LISTING);
  assert.ok(p.ok);
  const d = await q.decide(p.value.id, "reject", "axel@weichert.at");
  assert.ok(d.ok);
  assert.equal(d.value.status, "rejected");
});

test("Doppel-Entscheidung wird verhindert (kein Race/Doppel-Write)", async () => {
  const q = makeQueue();
  const p = await q.propose(GOOD_LISTING);
  assert.ok(p.ok);
  const first = await q.decide(p.value.id, "approve", "axel@weichert.at");
  assert.ok(first.ok);
  const second = await q.decide(p.value.id, "approve", "jemand@weichert.at");
  assert.ok(!second.ok);
  assert.match(second.message, /bereits 'approved'/);
});

test("markApplied nur fuer approved Items erlaubt", async () => {
  const q = makeQueue();
  const p = await q.propose(GOOD_LISTING);
  assert.ok(p.ok);
  const a = await q.markApplied(p.value.id, "x"); // noch pending
  assert.ok(!a.ok);
  assert.match(a.message, /freigegebene/);
});

test("markFailed haelt Item fuer manuelle Pruefung", async () => {
  const q = makeQueue();
  const p = await q.propose(GOOD_RECEIPT);
  assert.ok(p.ok);
  await q.decide(p.value.id, "approve", "axel@weichert.at");
  const f = await q.markFailed(p.value.id, "Etsy 422 Unprocessable");
  assert.ok(f.ok);
  assert.equal(f.value.status, "failed");
  assert.equal(f.value.error, "Etsy 422 Unprocessable");
});

test("decide auf unbekannte ID scheitert sauber", async () => {
  const q = makeQueue();
  const d = await q.decide("nope", "approve", "axel@weichert.at");
  assert.ok(!d.ok);
  assert.match(d.message, /Unbekannte/);
});

test("list gibt neueste zuerst", async () => {
  const q = makeQueue();
  await q.propose(GOOD_LISTING);
  await q.propose({ ...GOOD_LISTING, data: { title: "Zweite Vase" } });
  const all = await q.list();
  assert.equal(all[0].action.data.title, "Zweite Vase");
});
