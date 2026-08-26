// Tests für den CRM-Datenzugriff (K2-Port, VON-1817). Workerd-frei:
//   node --import tsx --test test/crm-store.test.ts
//
// Deckt In-Memory-Store (Lese-/Schreiblogik, LIMIT-Caps) UND die D1-SQL-Erzeugung
// (parametrisiert, nur allowlistete Spalten) über einen Fake-D1 ab.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MemoryCrmStore,
  D1CrmStore,
  MAX_READ_LIMIT,
  type D1Like,
  type CrmRow,
} from "../src/crm-store.ts";
import type { WriteAction } from "../src/crm-actions.ts";

// --- MemoryCrmStore -------------------------------------------------------

function seeded(): MemoryCrmStore {
  const s = new MemoryCrmStore();
  s.seed("contact", [
    { id: "c1", first_name: "Erika", last_name: "Mustermann", email: "erika@acme.de", company_id: "co-acme" },
    { id: "c2", first_name: "Max", last_name: "Beispiel", email: "max@globex.de", company_id: "co-globex" },
  ]);
  s.seed("deal", [
    { id: "d1", title: "ACME Rahmenvertrag", contact_id: "c1", stage: "open", value: 10000 },
    { id: "d2", title: "Globex Pilot", contact_id: "c2", stage: "won", value: 3000 },
  ]);
  return s;
}

test("read: Freitextsuche über Textspalten", async () => {
  const s = seeded();
  const hits = await s.read("contact", { search: "acme" });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, "c1");
});

test("read: Filter auf contactId (deals)", async () => {
  const s = seeded();
  const deals = await s.read("deal", { contactId: "c2" });
  assert.equal(deals.length, 1);
  assert.equal(deals[0].id, "d2");
});

test("read: LIMIT wird auf MAX_READ_LIMIT gedeckelt", async () => {
  const s = new MemoryCrmStore();
  const many: CrmRow[] = Array.from({ length: 500 }, (_, i) => ({ id: `x${i}`, first_name: `N${i}` }));
  s.seed("contact", many);
  const rows = await s.read("contact", { limit: 9999 });
  assert.equal(rows.length, MAX_READ_LIMIT);
});

test("getById liefert Datensatz oder undefined", async () => {
  const s = seeded();
  assert.equal((await s.getById("contact", "c1"))?.first_name, "Erika");
  assert.equal(await s.getById("contact", "nope"), undefined);
});

test("applyWrite create legt Datensatz an", async () => {
  const s = seeded();
  const action: WriteAction = {
    entity: "contact", op: "create",
    data: { first_name: "Neu", email: "neu@x.de" }, proposedBy: "agent",
  };
  const { id } = await s.applyWrite(action, () => "c-new");
  assert.equal(id, "c-new");
  assert.equal((await s.getById("contact", "c-new"))?.first_name, "Neu");
});

test("applyWrite update ändert nur gegebene Felder", async () => {
  const s = seeded();
  const action: WriteAction = {
    entity: "deal", op: "update", targetId: "d1",
    data: { stage: "won" }, proposedBy: "agent",
  };
  await s.applyWrite(action, () => "unused");
  const row = await s.getById("deal", "d1");
  assert.equal(row?.stage, "won");
  assert.equal(row?.title, "ACME Rahmenvertrag"); // unangetastet
});

test("applyWrite update auf nicht existierenden Datensatz wirft", async () => {
  const s = seeded();
  const action: WriteAction = {
    entity: "deal", op: "update", targetId: "ghost",
    data: { stage: "won" }, proposedBy: "agent",
  };
  await assert.rejects(() => s.applyWrite(action, () => "x"), /existiert nicht/);
});

// --- D1CrmStore: SQL-Erzeugung über Fake-D1 -------------------------------

type Call = { sql: string; params: unknown[] };

function fakeD1(): { db: D1Like; calls: Call[]; rows: CrmRow[] } {
  const calls: Call[] = [];
  const rows: CrmRow[] = [{ id: "c1", first_name: "Erika" }];
  const db: D1Like = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          calls.push({ sql, params });
          return {
            async all<T = CrmRow>() { return { results: rows as unknown as T[] }; },
            async first<T = CrmRow>() { return (rows[0] ?? null) as unknown as T | null; },
            async run() { return {}; },
          };
        },
      };
    },
  };
  return { db, calls, rows };
}

test("D1 read: parametrisiert mit LIMIT/OFFSET und Suche", async () => {
  const { db, calls } = fakeD1();
  const store = new D1CrmStore(db);
  await store.read("contact", { search: "acme", limit: 10, offset: 5 });
  const c = calls[0];
  assert.match(c.sql, /SELECT \* FROM contacts WHERE \(first_name LIKE \? OR last_name LIKE \? OR email LIKE \? OR phone LIKE \?\) LIMIT \? OFFSET \?/);
  // 4 LIKE-Params + limit + offset
  assert.deepEqual(c.params, ["%acme%", "%acme%", "%acme%", "%acme%", 10, 5]);
});

test("D1 create: INSERT nur mit allowlisteten Spalten, Werte gebunden", async () => {
  const { db, calls } = fakeD1();
  const store = new D1CrmStore(db);
  const action: WriteAction = {
    entity: "contact", op: "create",
    data: { first_name: "Neu", email: "n@x.de" }, proposedBy: "agent",
  };
  const { id } = await store.applyWrite(action, () => "gen-id");
  assert.equal(id, "gen-id");
  const c = calls[0];
  assert.equal(c.sql, "INSERT INTO contacts (id, first_name, email) VALUES (?, ?, ?)");
  assert.deepEqual(c.params, ["gen-id", "Neu", "n@x.de"]);
});

test("D1 update: UPDATE ... WHERE id = ? mit gebundenen Werten", async () => {
  const { db, calls } = fakeD1();
  const store = new D1CrmStore(db);
  const action: WriteAction = {
    entity: "deal", op: "update", targetId: "d1",
    data: { stage: "won", value: 5000 }, proposedBy: "agent",
  };
  await store.applyWrite(action, () => "unused");
  const c = calls[0];
  assert.equal(c.sql, "UPDATE deals SET stage = ?, value = ? WHERE id = ?");
  assert.deepEqual(c.params, ["won", 5000, "d1"]);
});
