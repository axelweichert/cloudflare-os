// PoC-Beweis fuer VON-1798 (Stufe 3/4-Gate). Laeuft workerd-frei & kostenfrei:
//   node --import tsx --test vonbusch/mailbox-gatekeeper/pin-mailbox.test.ts
//
// Modelliert einen agentic-inbox-artigen Upstream mit MEHREREN Mailboxen und mailbox-
// uebergreifenden Tools und beweist, dass der Pinning-Proxy Zugriff auf GENAU EINE Mailbox verengt.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPinPlan,
  gateToolCall,
  type McpTool,
  type AuditEvent,
  type ToolCallResult,
  type PinConfig,
  type PinPlan,
} from "./pin-mailbox.ts";

// --- Fake agentic-inbox /mcp: alle Mailboxen, keine per-mailbox-authz -----------------------------
const UPSTREAM_TOOLS: McpTool[] = [
  {
    name: "send_message",
    description: "Send an email from an inbox.",
    inputSchema: {
      type: "object",
      properties: { inbox_id: { type: "string" }, to: { type: "string" }, body: { type: "string" } },
      required: ["inbox_id", "to", "body"],
    },
  },
  {
    name: "list_messages",
    description: "List messages in an inbox.",
    inputSchema: {
      type: "object",
      properties: { inbox_id: { type: "string" } },
      required: ["inbox_id"],
    },
  },
  {
    // Mailbox-uebergreifend: kein inbox_id -> nicht verengbar -> muss verweigert werden.
    name: "list_all_inboxes",
    description: "List every inbox on the account.",
    inputSchema: { type: "object", properties: {} },
  },
];

const PINNED = "inbox_ceo@vonbusch.digital";

function collector() {
  const events: AuditEvent[] = [];
  return { audit: (e: AuditEvent) => events.push(e), events };
}

// Simuliert den vollen Proxy-Pfad inkl. Upstream-Weiterleitung.
function proxyCall(
  name: string,
  args: Record<string, unknown>,
  plan: PinPlan,
  cfg: PinConfig,
): ToolCallResult {
  const gate = gateToolCall(name, args, plan, cfg);
  if (!gate.allowed) return gate.result;
  // "Upstream": echot die tatsaechlich abgesetzten Argumente zurueck.
  return { content: [{ type: "text", text: JSON.stringify(gate.args) }] };
}

test("tools/list verengt: fremdes Feld weg, cross-mailbox-Tool entfernt", () => {
  const { audit, events } = collector();
  const { advertised } = buildPinPlan(UPSTREAM_TOOLS, { mailbox: PINNED, audit });

  const names = advertised.map(t => t.name).sort();
  assert.deepEqual(names, ["list_messages", "send_message"], "cross-mailbox-Tool muss verschwinden");

  const send = advertised.find(t => t.name === "send_message")!;
  assert.ok(!("inbox_id" in (send.inputSchema!.properties ?? {})), "inbox_id darf nicht beworben werden");
  assert.ok(!send.inputSchema!.required?.includes("inbox_id"), "inbox_id darf nicht required sein");
  assert.match(send.description!, /verengt/);
  assert.equal(events.at(-1)?.reason, "2/3 Tools freigegeben");
});

test("tools/call pinnt die Mailbox, wenn der Client keine angibt", () => {
  const cfg: PinConfig = { mailbox: PINNED };
  const plan = buildPinPlan(UPSTREAM_TOOLS, cfg);
  const res = proxyCall("send_message", { to: "kunde@example.com", body: "hi" }, plan, cfg);
  assert.ok(!res.isError);
  const sent = JSON.parse(res.content[0].text!);
  assert.equal(sent.inbox_id, PINNED, "Proxy muss die gepinnte Mailbox injizieren");
});

test("tools/call verweigert fremde Mailbox (Kern-Gate)", () => {
  const { audit, events } = collector();
  const cfg: PinConfig = { mailbox: PINNED, audit };
  const plan = buildPinPlan(UPSTREAM_TOOLS, cfg);
  const res = proxyCall("list_messages", { inbox_id: "inbox_opfer@vonbusch.digital" }, plan, cfg);
  assert.ok(res.isError, "fremde Mailbox muss abgelehnt werden");
  assert.match(res.content[0].text!, /fremde Mailbox/);
  assert.equal(events.at(-1)?.event, "call.refused");
});

test("tools/call verweigert nicht-freigegebenes / cross-mailbox Tool", () => {
  const cfg: PinConfig = { mailbox: PINNED };
  const plan = buildPinPlan(UPSTREAM_TOOLS, cfg);
  const res = proxyCall("list_all_inboxes", {}, plan, cfg);
  assert.ok(res.isError, "cross-mailbox-Tool muss verweigert werden");
  assert.match(res.content[0].text!, /nicht freigegeben|nicht verengbar/);
});

test("gepinnte Mailbox wird korrekt durchgereicht", () => {
  const cfg: PinConfig = { mailbox: PINNED };
  const plan = buildPinPlan(UPSTREAM_TOOLS, cfg);
  const res = proxyCall("list_messages", { inbox_id: PINNED }, plan, cfg);
  assert.ok(!res.isError);
  assert.equal(JSON.parse(res.content[0].text!).inbox_id, PINNED);
});
