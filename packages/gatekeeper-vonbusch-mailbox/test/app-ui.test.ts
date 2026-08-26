/**
 * Headless-Verifikation der Mailbox-Management-UI (VON-1845) — laeuft ohne Board/Browser:
 *   node --import tsx --test test/app-ui.test.ts
 *
 * Prueft (1) die reine Ableitung der Sicht aus Env-Primitiven (Backend-Modus, ACL-Metadaten),
 * (2) dass der gebackene Snapshot valides, netzisoliertes, escaptes HTML mit dem Freigabe-Modell
 * ist und (3) dass MailboxManagementApi read-only an die Sicht delegiert (kein Send/Mutate).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MailboxManagementApi,
  buildMailboxAppHtml,
  buildMailboxAppView,
} from "../src/app-ui.ts";

const ACL_WITH_MAILBOXES = JSON.stringify({
  mailboxes: { "team-inbox": ["a@x.de"], "sales": ["b@x.de", "c@x.de"] },
  admins: ["axel.weichert@vonbusch.digital"],
});

test("buildMailboxAppView leitet Backend-Modus und ACL-Metadaten ab", () => {
  const view = buildMailboxAppView({
    aclRaw: ACL_WITH_MAILBOXES,
    isAdmin: true,
    hasService: true,
    hasToken: false,
    upstreamUrl: "https://mail.vonbusch.app/mcp",
  });
  assert.equal(view.backendMode, "service-binding");
  assert.deepEqual(view.configuredMailboxes.sort(), ["sales", "team-inbox"]);
  assert.equal(view.adminCount, 1);
  assert.equal(view.isAdmin, true);
});

test("buildMailboxAppView faellt fail-closed auf leere ACL zurueck", () => {
  const view = buildMailboxAppView({
    aclRaw: "kein-json",
    isAdmin: false,
    hasService: false,
    hasToken: true,
    upstreamUrl: undefined,
  });
  assert.equal(view.backendMode, "token");
  assert.deepEqual(view.configuredMailboxes, []);
  assert.equal(view.adminCount, 0);
  assert.equal(view.upstreamUrl, "—");
});

test("backendMode 'none', wenn weder Service-Binding noch Token vorliegt", () => {
  const view = buildMailboxAppView({
    aclRaw: undefined,
    isAdmin: false,
    hasService: false,
    hasToken: false,
    upstreamUrl: "https://mail.vonbusch.app/mcp",
  });
  assert.equal(view.backendMode, "none");
});

test("buildMailboxAppHtml backt die Sicht als valides, netzisoliertes HTML", () => {
  const view = buildMailboxAppView({
    aclRaw: ACL_WITH_MAILBOXES,
    isAdmin: true,
    hasService: true,
    hasToken: false,
    upstreamUrl: "https://mail.vonbusch.app/mcp",
  });
  const html = buildMailboxAppHtml(view);

  assert.ok(html.startsWith("<!doctype html>"), "vollstaendiges HTML-Dokument");
  assert.match(html, /Content-Security-Policy/, "CSP gesetzt");
  assert.match(html, /default-src 'none'/, "netzisoliert");
  assert.match(html, /vonBusch Mailbox/, "Titel");
  assert.match(html, /team-inbox/, "Mailbox-ID gebacken");
  assert.match(html, /Service-Binding/, "Backend-Modus gebacken");
  assert.match(html, /Human-in-the-Loop-Freigabe/, "Freigabe-Modell erklaert");
  // Reiner, deklarativer Read-only-Snapshot: kein Skript im Frame.
  assert.ok(!/<script/i.test(html), "kein Skript im Frame");
});

test("HTML escaped gefaehrliche Mailbox-IDs", () => {
  const view = buildMailboxAppView({
    aclRaw: JSON.stringify({ mailboxes: { "<img src=x onerror=alert(1)>": ["a@x"] } }),
    isAdmin: false,
    hasService: true,
    hasToken: false,
    upstreamUrl: "https://mail.vonbusch.app/mcp",
  });
  const html = buildMailboxAppHtml(view);
  assert.ok(!html.includes("<img src=x"), "Rohes Markup nicht eingebettet");
  assert.match(html, /&lt;img src=x/, "escaped");
});

test("MailboxManagementApi delegiert read-only an die Sicht", async () => {
  const view = buildMailboxAppView({
    aclRaw: ACL_WITH_MAILBOXES,
    isAdmin: true,
    hasService: true,
    hasToken: false,
    upstreamUrl: "https://mail.vonbusch.app/mcp",
  });
  const api = new MailboxManagementApi(view);
  const got = await api.getView();
  assert.equal(got.backendMode, "service-binding");
  assert.equal(got.adminCount, 1);
  // Nur Reads exponiert — keine mutierende Methode (kein Send/Reply/Apply).
  assert.equal(typeof (api as unknown as { sendMessage?: unknown }).sendMessage, "undefined");
  assert.equal(typeof (api as unknown as { applyAction?: unknown }).applyAction, "undefined");
});
