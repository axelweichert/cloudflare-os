// vonBuschOS — CRM-Gatekeeper (K2, VON-1844): Tests für das Board-UI / Approval-Queue-Panel.
//
// Verifiziert den transport-freien Render-Kern (buildCrmAppHtml, esc) und die ui-Capability
// (CrmManagementApi) ohne workerd — headless per `node --import tsx --test`. Die DO-seitige
// Index-Spiegelung (recordPendingApproval/…) ist reine ctx.storage.kv-Delegation und wird durch
// die bestehenden session-core/store-Tests + `wrangler dev/dry-run` abgedeckt.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCrmAppHtml, esc, CrmManagementApi,
  type PendingApprovalView, type PendingApprovalSource,
} from "../src/app-ui.ts";

function view(over: Partial<PendingApprovalView> = {}): PendingApprovalView {
  return {
    connToken: "acct-1",
    actionId: 7,
    entity: "contact",
    op: "create",
    title: "Kontakt anlegen",
    description: "Vorschlag, im CRM einen Kontakt zu anlegen:\n\n- **name:** Ada Lovelace\n- **email:** ada@example.com\n\n**Begründung:** Messe-Lead",
    proposedBy: "gadget-x",
    proposedAt: Date.UTC(2026, 7, 26, 9, 30),
    ...over,
  };
}

test("esc escapt HTML-Metazeichen", () => {
  assert.equal(esc(`<a href="x">&`), "&lt;a href=&quot;x&quot;&gt;&amp;");
  assert.equal(esc(null), "");
  assert.equal(esc(undefined), "");
  assert.equal(esc(42), "42");
});

test("leere Queue: grüner Banner + Hinweistext", () => {
  const html = buildCrmAppHtml([], "2026-08-26T09:30:00.000Z");
  assert.match(html, /Keine offenen Freigaben/);
  assert.match(html, /proposeContact/);
  assert.match(html, /vonBusch CRM — Freigaben/);
  // Kein Skript, strikte CSP.
  assert.match(html, /default-src 'none'/);
  assert.doesNotMatch(html, /<script/i);
});

test("nicht-leere Queue: Anzahl, Entity-Label, Verb-Badge, Feldliste", () => {
  const html = buildCrmAppHtml([view(), view({ actionId: 8, entity: "deal", op: "update", targetId: "d-99", title: "Deal ändern" })], "2026-08-26T09:31:00.000Z");
  assert.match(html, /2 offene Freigaben/);
  assert.match(html, /Kontakt/);
  assert.match(html, /Deal/);
  assert.match(html, /badge-create/);
  assert.match(html, /badge-update/);
  assert.match(html, /Ada Lovelace/);
  assert.match(html, /ada@example\.com/);
  assert.match(html, /Messe-Lead/);
  assert.match(html, /#d-99/); // targetId sichtbar
  assert.match(html, /#7/);    // actionId sichtbar
});

test("Singular/Plural im Banner", () => {
  assert.match(buildCrmAppHtml([view()], "t"), /1 offene Freigabe\b/);
  assert.doesNotMatch(buildCrmAppHtml([view()], "t"), /1 offene Freigaben/);
});

test("Feldwerte werden escaped (kein HTML-Injection über CRM-Daten)", () => {
  const html = buildCrmAppHtml([view({
    description: "- **notes:** <img src=x onerror=alert(1)>\n- **name:** </style><script>evil()</script>",
    proposedBy: `"><script>x`,
  })], "t");
  assert.doesNotMatch(html, /<script>evil/);
  assert.doesNotMatch(html, /<img src=x onerror/);
  assert.match(html, /&lt;img src=x onerror/);
  assert.match(html, /&lt;script&gt;evil/);
  // proposedBy-Attribut/-Text ebenfalls escaped.
  assert.match(html, /&quot;&gt;&lt;script&gt;x/);
});

test("null-Feldwert wird als ∅ gerendert", () => {
  const html = buildCrmAppHtml([view({ description: "- **phone:** " })], "t");
  assert.match(html, /∅/);
});

test("CrmManagementApi delegiert listPendingApprovals an die Quelle", async () => {
  const pending = [view()];
  let calls = 0;
  const source: PendingApprovalSource = {
    listPendingApprovals: async () => { calls++; return pending; },
  };
  const api = new CrmManagementApi(source);
  const got = await api.listPendingApprovals();
  assert.equal(calls, 1);
  assert.deepEqual(got, pending);
});
