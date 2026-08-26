// Tests für die Schreibaktions-Validierung (K2-Port, VON-1817). Workerd-frei:
//   node --import tsx --test test/crm-actions.test.ts
//
// Portiert den Validierungsteil aus dem Ursprungs-Baustein (write-queue.test.ts). Der
// Freigabe-Automat selbst (pending→approve→apply) ist im OS-Port die OS-`ApprovalQueue`; er wird
// über session-core.test.ts (submitAction/applyAction) abgedeckt.

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateAction, COLUMN_ALLOWLIST } from "../src/crm-actions.ts";

const GOOD_CREATE = {
  entity: "contact",
  op: "create",
  data: { first_name: "Erika", last_name: "Mustermann", email: "erika@example.com", company_id: "co-acme" },
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

test("validateAction akzeptiert gültiges update mit targetId", () => {
  const r = validateAction(GOOD_UPDATE);
  assert.ok(r.ok);
  assert.equal(r.value.targetId, "deal-42");
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
  const r = validateAction({ ...GOOD_CREATE, data: { first_name: "X", evil_sql: "1;DROP" } });
  assert.ok(!r.ok);
  assert.match(r.message, /nicht erlaubt/);
});

test("validateAction lehnt Nicht-Primitive Werte ab", () => {
  const r = validateAction({ ...GOOD_CREATE, data: { first_name: { nested: true } } });
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

test("validateAction lehnt zu lange String-Werte ab", () => {
  const r = validateAction({ ...GOOD_CREATE, data: { first_name: "x".repeat(30_000) } });
  assert.ok(!r.ok);
  assert.match(r.message, /zu lang/);
});

test("COLUMN_ALLOWLIST deckt genau die drei Entities ab", () => {
  assert.deepEqual(Object.keys(COLUMN_ALLOWLIST).sort(), ["activity", "contact", "deal"]);
});
