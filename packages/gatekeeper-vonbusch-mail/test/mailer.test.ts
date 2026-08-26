// vonBuschOS — Mail-Gatekeeper (K5-Port, VON-1818): Tests für den MIME-Bau (rein, workerd-frei).
// node --import tsx --test test/mailer.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMime, encodeHeaderValue } from "../src/mailer.ts";
import type { EmailProposal } from "../src/mail-actions.ts";

const MSG: EmailProposal = {
  to: "kunde@example.com",
  from: "noreply@vonbusch.app",
  subject: "Angebot",
  text: "Guten Tag,\nanbei Ihr Angebot.\n",
  proposedBy: "agent-crm",
};

test("encodeHeaderValue lässt ASCII unangetastet", () => {
  assert.equal(encodeHeaderValue("Angebot 2026"), "Angebot 2026");
});

test("encodeHeaderValue RFC-2047-kodiert Nicht-ASCII", () => {
  const enc = encodeHeaderValue("Grüße vom Süden");
  assert.match(enc, /^=\?UTF-8\?B\?.+\?=$/);
});

test("encodeHeaderValue entschärft Zeilenumbrüche (Header-Injection)", () => {
  const enc = encodeHeaderValue("Hi\r\nBcc: victim@x.com");
  assert.ok(!/\r|\n/.test(enc));
});

test("buildMime setzt korrekte Header und base64-Body", () => {
  const mime = buildMime(MSG, "msg-123");
  assert.match(mime, /^From: noreply@vonbusch\.app\r\n/);
  assert.match(mime, /\r\nTo: kunde@example\.com\r\n/);
  assert.match(mime, /\r\nSubject: Angebot\r\n/);
  assert.match(mime, /\r\nMessage-ID: <msg-123@vonbusch\.app>\r\n/);
  assert.match(mime, /Content-Transfer-Encoding: base64\r\n/);
  // Body ist base64 des Klartexts.
  const bodyStart = mime.indexOf("\r\n\r\n") + 4;
  const body = mime.slice(bodyStart).replace(/\r\n/g, "");
  assert.equal(Buffer.from(body, "base64").toString("utf-8"), MSG.text);
});

test("buildMime nutzt Absender-Domain für die Message-ID", () => {
  const mime = buildMime({ ...MSG, from: "team@sub.beispiel.de" }, "abc");
  assert.match(mime, /Message-ID: <abc@sub\.beispiel\.de>/);
});
