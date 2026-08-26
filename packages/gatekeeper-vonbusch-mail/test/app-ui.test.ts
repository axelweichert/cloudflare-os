// vonBuschOS — Mail-Gatekeeper (K5, VON-1847): Tests für das Board-UI / Approval-Queue-Panel.
//
// Verifiziert den transport-freien Render-Kern (buildMailAppHtml, esc, preview) und die
// ui-Capability (MailManagementApi) ohne workerd — headless per `node --import tsx --test`. Die
// DO-seitige Index-Spiegelung (recordPendingApproval/…) ist reine ctx.storage.kv-Delegation und
// wird durch die bestehenden session-core-Tests + `wrangler dev/dry-run` abgedeckt.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildMailAppHtml, esc, preview, MailManagementApi,
  type PendingApprovalView, type PendingApprovalSource,
} from "../src/app-ui.ts";

function view(over: Partial<PendingApprovalView> = {}): PendingApprovalView {
  return {
    connToken: "acct-1",
    actionId: 7,
    to: "kunde@example.com",
    from: "noreply@vonbusch.app",
    subject: "Ihr Angebot",
    text: "Guten Tag,\n\nanbei Ihr Angebot.\n\nBeste Grüße",
    reason: "Angebots-Nachfass",
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

test("preview kürzt langen Body an Wortgrenze mit Ellipsis", () => {
  const long = "wort ".repeat(200).trim();
  const p = preview(long, 40);
  assert.ok(p.length <= 41, `preview zu lang: ${p.length}`);
  assert.match(p, /…$/);
  // Kurzer Text bleibt unverändert (nur Whitespace normalisiert).
  assert.equal(preview("a\n\n b", 40), "a b");
});

test("leere Queue: grüner Banner + Hinweistext", () => {
  const html = buildMailAppHtml([], "2026-08-26T09:30:00.000Z");
  assert.match(html, /Keine offenen Sende-Freigaben/);
  assert.match(html, /proposeEmail/);
  assert.match(html, /vonBusch Mail — Freigaben/);
  // Kein Skript, strikte CSP.
  assert.match(html, /default-src 'none'/);
  assert.doesNotMatch(html, /<script/i);
});

test("nicht-leere Queue: Anzahl, Betreff, Empfänger/Absender, Begründung", () => {
  const html = buildMailAppHtml(
    [view(), view({ actionId: 8, subject: "Rechnung", to: "buchhaltung@example.com", reason: undefined })],
    "2026-08-26T09:31:00.000Z",
  );
  assert.match(html, /2 offene Sende-Freigaben/);
  assert.match(html, /Ihr Angebot/);
  assert.match(html, /Rechnung/);
  assert.match(html, /kunde@example\.com/);
  assert.match(html, /noreply@vonbusch\.app/);
  assert.match(html, /Angebots-Nachfass/);
  assert.match(html, /#7/); // actionId sichtbar
});

test("Singular/Plural im Banner", () => {
  assert.match(buildMailAppHtml([view()], "t"), /1 offene Sende-Freigabe\b/);
  assert.doesNotMatch(buildMailAppHtml([view()], "t"), /1 offene Sende-Freigaben/);
});

test("Mail-Inhalte werden escaped (kein HTML-Injection über to/subject/text/proposedBy)", () => {
  const html = buildMailAppHtml([view({
    subject: "</style><script>evil()</script>",
    text: "<img src=x onerror=alert(1)>",
    to: `"><script>x`,
    proposedBy: `"><script>y`,
  })], "t");
  assert.doesNotMatch(html, /<script>evil/);
  assert.doesNotMatch(html, /<img src=x onerror/);
  assert.match(html, /&lt;script&gt;evil/);
  assert.match(html, /&lt;img src=x onerror/);
  assert.match(html, /&quot;&gt;&lt;script&gt;x/);
  assert.match(html, /&quot;&gt;&lt;script&gt;y/);
});

test("leerer Body wird als ∅ gerendert", () => {
  const html = buildMailAppHtml([view({ text: "" })], "t");
  assert.match(html, /∅/);
});

test("MailManagementApi delegiert listPendingApprovals an die Quelle", async () => {
  const pending = [view()];
  let calls = 0;
  const source: PendingApprovalSource = {
    listPendingApprovals: async () => { calls++; return pending; },
  };
  const api = new MailManagementApi(source);
  const got = await api.listPendingApprovals();
  assert.equal(calls, 1);
  assert.deepEqual(got, pending);
});
