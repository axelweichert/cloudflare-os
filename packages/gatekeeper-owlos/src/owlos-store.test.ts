// owlOS ERP-Store — Unit-Tests (workerd-frei): node --import tsx --test
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MemoryOwlosStore,
  D1OwlosStore,
  validateWrite,
  type D1Like,
} from "./owlos-store.ts";

test("offene Posten = Rechnungen mit status 'offen' je Kunde", async () => {
  const s = new MemoryOwlosStore();
  s.seed("rechnung", [
    { id: "r1", kunde_id: "k1", betrag: 100, status: "offen" },
    { id: "r2", kunde_id: "k1", betrag: 50, status: "bezahlt" },
    { id: "r3", kunde_id: "k2", betrag: 80, status: "offen" },
  ]);
  const offen = await s.read("rechnung", { kundeId: "k1", status: "offen" });
  assert.deepEqual(offen.map((r) => r.id), ["r1"]);
});

test("Angebot anlegen und zum Auftrag hochstufen", async () => {
  const s = new MemoryOwlosStore();
  let n = 0;
  const create = validateWrite({
    entity: "angebot", op: "create",
    data: { kunde_id: "k1", titel: "Edge-Migration", betrag: 5000, status: "angebot" },
    proposedBy: "agent-1",
  });
  assert.ok(create.ok);
  const { id } = await s.applyWrite(create.value, () => `a${++n}`);
  const up = validateWrite({ entity: "angebot", op: "update", targetId: id, data: { status: "auftrag" }, proposedBy: "agent-1" });
  assert.ok(up.ok);
  await s.applyWrite(up.value, () => "x");
  const row = await s.getById("angebot", id);
  assert.equal(row?.status, "auftrag");
  assert.equal(row?.titel, "Edge-Migration");
});

test("unbekannte Spalte wird abgelehnt (Injection-Schutz)", () => {
  const r = validateWrite({ entity: "kunde", op: "create", data: { "name); DROP TABLE kunden;--": "x" }, proposedBy: "a" });
  assert.equal(r.ok, false);
});

test("create mit targetId wird abgelehnt", () => {
  const r = validateWrite({ entity: "kunde", op: "create", targetId: "k1", data: { name: "X" }, proposedBy: "a" });
  assert.equal(r.ok, false);
});

test("D1-Store erzeugt parametrisiertes SQL (kein Nutzdaten-Interpolieren)", async () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  const fakeDb: D1Like = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          calls.push({ sql, params });
          return {
            async all<T>() { return { results: [] as T[] }; },
            async first<T>() { return null as T | null; },
            async run() { return {}; },
          };
        },
      };
    },
  };
  const s = new D1OwlosStore(fakeDb);
  await s.read("rechnung", { kundeId: "k1", status: "offen" });
  assert.match(calls[0].sql, /SELECT \* FROM rechnungen WHERE kunde_id = \? AND status = \? LIMIT \? OFFSET \?/);
  assert.deepEqual(calls[0].params.slice(0, 2), ["k1", "offen"]);

  const create = validateWrite({ entity: "rechnung", op: "create", data: { kunde_id: "k1", betrag: 100, status: "offen" }, proposedBy: "a" });
  assert.ok(create.ok);
  await s.applyWrite(create.value, () => "r9");
  const ins = calls[1];
  assert.match(ins.sql, /INSERT INTO rechnungen \(id, kunde_id, betrag, status\) VALUES \(\?, \?, \?, \?\)/);
  assert.deepEqual(ins.params, ["r9", "k1", 100, "offen"]);
});
