// Beweist die reine Logik des Mailbox-Ressourcen-Konfigurators (VON-1864). workerd-frei:
//   node --import tsx --test test/mailbox-configurator.test.ts
//
// render() wird NICHT aufgerufen (bräuchte die Sandbox-Runtime für h/Section/Field/TextInput);
// getestet werden die Vertrags-Callbacks isReady/initialValuesFromResourceUrl/resourceUrl.

import { test } from "node:test";
import assert from "node:assert/strict";
import spec from "../src/configurator/mailbox-configurator-ui.tsx";

// Baut die URL exakt so wie die Vendor-`ui`-Capability (buildResourceUrl) — Testdouble.
const ui = {
  async resourceUrl(inboxId: string): Promise<string> {
    const id = inboxId.trim();
    if (!id) throw new Error("Inbox-ID darf nicht leer sein.");
    return `https://mail.vonbusch.app/inbox/${encodeURIComponent(id)}`;
  },
};

test("isReady: erst mit nicht-leerer Inbox-ID", () => {
  assert.equal(spec.isReady!({ values: { inboxId: null } }), false);
  assert.equal(spec.isReady!({ values: { inboxId: "" } }), false);
  assert.equal(spec.isReady!({ values: { inboxId: "   " } }), false);
  assert.equal(spec.isReady!({ values: { inboxId: "team-vertrieb" } }), true);
});

test("resourceUrl: baut .../inbox/<id> und encodiert", async () => {
  assert.equal(
    await spec.resourceUrl({ values: { inboxId: "team-vertrieb" }, ui }),
    "https://mail.vonbusch.app/inbox/team-vertrieb");
  // trimmt und encodiert Sonderzeichen
  assert.equal(
    await spec.resourceUrl({ values: { inboxId: "  a b@x  " }, ui }),
    "https://mail.vonbusch.app/inbox/a%20b%40x");
});

test("resourceUrl: leere ID wirft (fail-fast, wie Vendor)", async () => {
  await assert.rejects(() => Promise.resolve(spec.resourceUrl({ values: { inboxId: "  " }, ui })));
});

test("initialValuesFromResourceUrl: konkrete URL füllt inboxId vor", async () => {
  const vals = await spec.initialValuesFromResourceUrl!({
    resourceUrl: "https://mail.vonbusch.app/inbox/team-vertrieb",
    resourceUrlPattern: "https://mail.vonbusch.app/inbox/*",
    ui,
  });
  assert.deepEqual(vals, { inboxId: "team-vertrieb" });
});

test("initialValuesFromResourceUrl: encodierte ID wird dekodiert; Müll ⇒ leer", async () => {
  const vals = await spec.initialValuesFromResourceUrl!({
    resourceUrl: "https://mail.vonbusch.app/inbox/a%20b%40x",
    resourceUrlPattern: "https://mail.vonbusch.app/inbox/*",
    ui,
  });
  assert.deepEqual(vals, { inboxId: "a b@x" });
  assert.deepEqual(
    await spec.initialValuesFromResourceUrl!({ resourceUrl: "kein-url", resourceUrlPattern: "", ui }),
    {});
});
