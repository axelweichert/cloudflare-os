// Beweist die interne per-Mailbox-Autorisierung (schließt die VON-1798-Lücke). workerd-frei:
//   node --import tsx --test test/mailbox-authz.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseAcl, canObserveMailbox, allowedMailboxesFor, isAclAdmin, canBindAnyMailbox,
} from "../src/mailbox-authz.ts";

const ACL_JSON = JSON.stringify({
  mailboxes: {
    "inbox_ceo@vonbusch.digital": ["axel@vonbusch.digital"],
    "inbox_sales@vonbusch.digital": ["sales@vonbusch.digital", "axel@vonbusch.digital"],
  },
  admins: ["cto@vonbusch.digital"],
});

test("parseAcl: ungültig/fehlend ⇒ leere fail-closed ACL", () => {
  assert.deepEqual(parseAcl(undefined).mailboxes, {});
  assert.deepEqual(parseAcl("nicht json").mailboxes, {});
});

test("canObserveMailbox: nur gelistete Identität darf ihre Mailbox sehen", () => {
  const acl = parseAcl(ACL_JSON);
  assert.equal(canObserveMailbox(acl, "inbox_ceo@vonbusch.digital", "axel@vonbusch.digital"), true);
  // Case-insensitiv.
  assert.equal(canObserveMailbox(acl, "inbox_ceo@vonbusch.digital", "AXEL@vonbusch.digital"), true);
});

test("canObserveMailbox fail-closed: fremde Identität und unbekannte Mailbox ⇒ false", () => {
  const acl = parseAcl(ACL_JSON);
  // sales darf ceo NICHT sehen
  assert.equal(canObserveMailbox(acl, "inbox_ceo@vonbusch.digital", "sales@vonbusch.digital"), false);
  // unbekannte Mailbox
  assert.equal(canObserveMailbox(acl, "inbox_hr@vonbusch.digital", "axel@vonbusch.digital"), false);
  // leere Identität
  assert.equal(canObserveMailbox(acl, "inbox_ceo@vonbusch.digital", null), false);
  // leere ACL sperrt alles
  assert.equal(canObserveMailbox(parseAcl(undefined), "inbox_ceo@vonbusch.digital", "axel@vonbusch.digital"), false);
});

test("admins dürfen jede Mailbox", () => {
  const acl = parseAcl(ACL_JSON);
  assert.equal(canObserveMailbox(acl, "inbox_ceo@vonbusch.digital", "cto@vonbusch.digital"), true);
  assert.equal(canObserveMailbox(acl, "inbox_sales@vonbusch.digital", "cto@vonbusch.digital"), true);
});

test("allowedMailboxesFor steuert Sichtbarkeit: Nicht-Berechtigte sehen nichts", () => {
  const acl = parseAcl(ACL_JSON);
  assert.deepEqual(allowedMailboxesFor(acl, "sales@vonbusch.digital"), ["inbox_sales@vonbusch.digital"]);
  assert.deepEqual(allowedMailboxesFor(acl, "fremd@example.com"), []);
  // Admin sieht alle
  assert.equal(allowedMailboxesFor(acl, "cto@vonbusch.digital").length, 2);
});

test("isAclAdmin: nur gelistete Admins, case-insensitiv, fail-closed", () => {
  const acl = parseAcl(ACL_JSON);
  assert.equal(isAclAdmin(acl, "cto@vonbusch.digital"), true);
  assert.equal(isAclAdmin(acl, "CTO@VONBUSCH.DIGITAL"), true);
  assert.equal(isAclAdmin(acl, "axel@vonbusch.digital"), false); // gelistet, aber kein Admin
  assert.equal(isAclAdmin(acl, null), false);
});

test("canBindAnyMailbox: Admin sichtbar auch bei leerem mailboxes (VON-1864-Regression)", () => {
  // Aktuelle Deploy-Config: nur admins, keine gelisteten Mailboxen. Der Admin muss den Vendor im
  // add-resource-Pfad trotzdem SEHEN, sonst kann er per Konfigurator keine Inbox-ID binden.
  const adminOnly = parseAcl(JSON.stringify({ mailboxes: {}, admins: ["axel.weichert@vonbusch.digital"] }));
  assert.equal(allowedMailboxesFor(adminOnly, "axel.weichert@vonbusch.digital").length, 0);
  assert.equal(canBindAnyMailbox(adminOnly, "axel.weichert@vonbusch.digital"), true);
  // Nicht-Admin ohne gelistete Mailbox bleibt unsichtbar (fail-closed).
  assert.equal(canBindAnyMailbox(adminOnly, "fremd@example.com"), false);
  assert.equal(canBindAnyMailbox(adminOnly, null), false);
});

test("canBindAnyMailbox: gelisteter Nicht-Admin ist sichtbar", () => {
  const acl = parseAcl(ACL_JSON);
  assert.equal(canBindAnyMailbox(acl, "sales@vonbusch.digital"), true);
  assert.equal(canBindAnyMailbox(acl, "fremd@example.com"), false);
});
