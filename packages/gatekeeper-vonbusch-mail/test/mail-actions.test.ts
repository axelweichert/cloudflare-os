// vonBuschOS — Mail-Gatekeeper (K5-Port, VON-1818): Tests für den Validierungskern.
// Workerd-frei:  node --import tsx --test test/mail-actions.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateProposal,
  isEmail,
  parseAllowedFrom,
  resolveDefaultFrom,
  type QueueConfig,
} from "../src/mail-actions.ts";

const CONFIG: QueueConfig = { allowedFrom: ["noreply@vonbusch.app"] };

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

test("validateProposal akzeptiert einen sauberen Vorschlag und trimmt", () => {
  const r = validateProposal({ ...GOOD, to: "  kunde@example.com  " }, CONFIG);
  assert.ok(r.ok);
  assert.equal(r.value.to, "kunde@example.com");
  assert.equal(r.value.reason, "Follow-up nach Anfrage");
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

test("validateProposal erzwingt Längen-Caps", () => {
  assert.ok(!validateProposal({ ...GOOD, subject: "x".repeat(201) }, { ...CONFIG, maxSubjectLen: 200 }).ok);
  assert.ok(!validateProposal({ ...GOOD, text: "x".repeat(11) }, { ...CONFIG, maxBodyLen: 10 }).ok);
});

test("validateProposal lehnt Nicht-Objekte ab", () => {
  assert.ok(!validateProposal(null, CONFIG).ok);
  assert.ok(!validateProposal("nope", CONFIG).ok);
});

test("parseAllowedFrom zerlegt Kommaliste und trimmt", () => {
  assert.deepEqual(parseAllowedFrom(" a@x.de , b@x.de ,"), ["a@x.de", "b@x.de"]);
  assert.deepEqual(parseAllowedFrom(undefined, "c@x.de"), ["c@x.de"]);
  assert.deepEqual(parseAllowedFrom(undefined, undefined), ["noreply@vonbusch.app"]);
});

test("resolveDefaultFrom bevorzugt DEFAULT_FROM, sonst erste Allowlist-Adresse", () => {
  assert.equal(resolveDefaultFrom("a@x.de,b@x.de", "b@x.de"), "b@x.de");
  assert.equal(resolveDefaultFrom("a@x.de,b@x.de", undefined), "a@x.de");
  assert.equal(resolveDefaultFrom(undefined, undefined), "noreply@vonbusch.app");
});
