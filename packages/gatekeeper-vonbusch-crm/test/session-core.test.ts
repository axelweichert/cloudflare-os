// Tests für den transport-freien Session-Kern (K2-Port, VON-1817). Workerd-frei:
//   node --import tsx --test test/session-core.test.ts
//
// Prüft das Approval-/Observation-Gerüst OHNE workerd:
//   - Reads autorisieren JEDE Rückgabe über authorizeObservation() (Fetch → Authorize → Return).
//   - Writes werden NUR eingereiht (submitAction), NIE direkt ausgeführt.
//   - Ungültige Vorschläge werden gar nicht erst eingereiht (Validierung greift vor der Queue).
//   - applyCrmAction führt eine freigegebene Aktion tatsächlich auf dem Store aus.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryCrmStore } from "../src/crm-store.ts";
import {
  CrmSessionCore, applyCrmAction, CRM_WRITE_KIND,
  type ObservationDescription, type ActionDescription, type PendingCrmAction,
} from "../src/session-core.ts";

function seeded(): MemoryCrmStore {
  const s = new MemoryCrmStore();
  s.seed("contact", [
    { id: "c1", first_name: "Erika", last_name: "Mustermann", email: "erika@acme.de", company_id: "ACME" },
    { id: "c2", first_name: "Max", last_name: "Beispiel", email: "max@globex.de", company_id: "Globex" },
  ]);
  s.seed("deal", [{ id: "d1", title: "ACME Rahmenvertrag", contact_id: "c1", stage: "open" }]);
  return s;
}

type Enqueued = { action: PendingCrmAction; description: ActionDescription; id: number };

function harness(opts: { denyObservation?: boolean } = {}) {
  const observations: ObservationDescription[] = [];
  const enqueued: Enqueued[] = [];
  const store = seeded();
  const authorizer = {
    async authorizeObservation(d: ObservationDescription) {
      observations.push(d);
      if (opts.denyObservation) throw new Error("Beobachtung nicht erlaubt");
    },
  };
  const actions = {
    async enqueue(action: PendingCrmAction, description: ActionDescription) {
      const id = enqueued.length + 1;
      enqueued.push({ action, description, id });
      return id;
    },
  };
  const core = new CrmSessionCore(store, authorizer, actions, "gadget-xyz");
  return { core, store, observations, enqueued };
}

// --- Reads ----------------------------------------------------------------

test("listContacts: autorisiert die Beobachtung und liefert Daten", async () => {
  const h = harness();
  const rows = await h.core.listContacts({ search: "acme" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "c1");
  assert.equal(h.observations.length, 1);
  assert.match(h.observations[0].title, /Kontakte auflisten/);
  assert.equal(h.observations[0].prohibitAllSharing, true);
});

test("getContact: autorisiert auch bei Nicht-Fund (null)", async () => {
  const h = harness();
  const row = await h.core.getContact("ghost");
  assert.equal(row, null);
  assert.equal(h.observations.length, 1);
  assert.match(h.observations[0].description, /nicht gefunden/);
});

test("Read wird bei verweigerter Beobachtung NICHT zurückgegeben (fail-closed)", async () => {
  const h = harness({ denyObservation: true });
  await assert.rejects(() => h.core.listDeals(), /nicht erlaubt/);
});

// --- Writes ---------------------------------------------------------------

test("proposeContact: reiht ein, schreibt NICHT, liefert pending_approval", async () => {
  const h = harness();
  const res = await h.core.proposeContact({ op: "create", fields: { first_name: "Neu", email: "n@x.de" } });
  assert.equal(res.status, "pending_approval");
  assert.equal(res.actionId, 1);
  // Genau eine eingereihte Aktion, mit stabilem Action-Kind, kein Auto-Approve.
  assert.equal(h.enqueued.length, 1);
  assert.deepEqual(h.enqueued[0].description.actionKind, CRM_WRITE_KIND);
  assert.equal(h.enqueued[0].description.autoApprovable, undefined);
  assert.equal(h.enqueued[0].action.proposedBy, "gadget-xyz");
  // Der Store wurde NICHT verändert.
  const rows = await h.store.read("contact");
  assert.equal(rows.length, 2);
});

test("proposeDeal update: übernimmt targetId in die eingereihte Aktion", async () => {
  const h = harness();
  const res = await h.core.proposeDeal({ op: "update", targetId: "d1", fields: { stage: "won" } });
  assert.equal(res.status, "pending_approval");
  assert.equal(h.enqueued[0].action.entity, "deal");
  assert.equal(h.enqueued[0].action.targetId, "d1");
});

test("ungültiger Vorschlag wird gar nicht erst eingereiht (Allowlist)", async () => {
  const h = harness();
  await assert.rejects(
    () => h.core.proposeContact({ op: "create", fields: { evil_sql: "1;DROP" } }),
    /nicht erlaubt/,
  );
  assert.equal(h.enqueued.length, 0);
});

test("proposeActivity create verbietet targetId", async () => {
  const h = harness();
  await assert.rejects(
    () => h.core.proposeActivity({ op: "create", targetId: "x", fields: { subject: "Call" } }),
    /create darf keine targetId/,
  );
  assert.equal(h.enqueued.length, 0);
});

// --- Apply (nach Freigabe) ------------------------------------------------

test("applyCrmAction führt eine freigegebene create-Aktion auf dem Store aus", async () => {
  const h = harness();
  await h.core.proposeContact({ op: "create", fields: { first_name: "Neu", email: "n@x.de" } });
  const action = h.enqueued[0].action;
  const { id } = await applyCrmAction(h.store, action, () => "c-new");
  assert.equal(id, "c-new");
  assert.equal((await h.store.getById("contact", "c-new"))?.first_name, "Neu");
});

test("applyCrmAction führt eine freigegebene update-Aktion aus", async () => {
  const h = harness();
  await h.core.proposeDeal({ op: "update", targetId: "d1", fields: { stage: "won" } });
  await applyCrmAction(h.store, h.enqueued[0].action, () => "unused");
  assert.equal((await h.store.getById("deal", "d1"))?.stage, "won");
});
