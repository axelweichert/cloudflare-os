// Tests für MCP-Server + MIME-Bau (VON-1802 / K5). Workerd-frei:
//   node --import tsx --test vonbusch/mail-gatekeeper/mcp-server.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { MailApprovalQueue, MemoryQueueStore, type QueueConfig } from "./approval-queue.ts";
import { handleMcpMessage, type McpContext } from "./mcp-server.ts";
import { buildMime, encodeHeaderValue } from "./mailer.ts";

const CONFIG: QueueConfig = { allowedFrom: ["noreply@vonbusch.app"] };

function makeCtx(callerId = "agent-crm"): McpContext {
  let n = 0;
  const queue = new MailApprovalQueue(
    new MemoryQueueStore(),
    CONFIG,
    () => "2026-08-25T00:00:00.000Z",
    () => `id-${++n}`,
  );
  return { queue, defaultFrom: "noreply@vonbusch.app", callerId };
}

test("initialize gibt serverInfo + Protokoll", async () => {
  const r = await handleMcpMessage(makeCtx(), { jsonrpc: "2.0", id: 1, method: "initialize" });
  assert.ok(r && "result" in r);
  const res = (r as any).result;
  assert.equal(res.serverInfo.name, "gatekeeper-vonbusch-mail");
  assert.equal(res.protocolVersion, "2025-06-18");
});

test("tools/list exponiert propose_email", async () => {
  const r = await handleMcpMessage(makeCtx(), { jsonrpc: "2.0", id: 2, method: "tools/list" });
  const names = (r as any).result.tools.map((t: any) => t.name);
  assert.deepEqual(names.sort(), ["list_my_proposals", "propose_email"]);
});

test("notifications/initialized liefert keine Antwort", async () => {
  const r = await handleMcpMessage(makeCtx(), { jsonrpc: "2.0", id: null, method: "notifications/initialized" });
  assert.equal(r, null);
});

test("propose_email legt pending Item mit callerId als proposedBy an", async () => {
  const ctx = makeCtx("agent-crm");
  const r = await handleMcpMessage(ctx, {
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "propose_email", arguments: { to: "k@example.com", subject: "Hi", text: "Hallo" } },
  });
  const payload = JSON.parse((r as any).result.content[0].text);
  assert.equal(payload.status, "pending");
  const items = await ctx.queue.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].proposal.proposedBy, "agent-crm");
  assert.equal(items[0].proposal.from, "noreply@vonbusch.app"); // defaultFrom
});

test("propose_email mit unerlaubtem from wird als isError abgelehnt", async () => {
  const ctx = makeCtx();
  const r = await handleMcpMessage(ctx, {
    jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "propose_email", arguments: { to: "k@example.com", from: "evil@x.com", subject: "Hi", text: "Hallo" } },
  });
  assert.equal((r as any).result.isError, true);
  assert.equal((await ctx.queue.list()).length, 0);
});

test("list_my_proposals filtert nach callerId", async () => {
  const ctx = makeCtx("agent-a");
  await ctx.queue.propose({ to: "k@example.com", from: "noreply@vonbusch.app", subject: "A", text: "x", proposedBy: "agent-a" });
  await ctx.queue.propose({ to: "k@example.com", from: "noreply@vonbusch.app", subject: "B", text: "x", proposedBy: "agent-b" });
  const r = await handleMcpMessage(ctx, {
    jsonrpc: "2.0", id: 5, method: "tools/call",
    params: { name: "list_my_proposals", arguments: {} },
  });
  const list = JSON.parse((r as any).result.content[0].text);
  assert.equal(list.length, 1);
  assert.equal(list[0].subject, "A");
});

test("unbekannte Methode → JSON-RPC Fehler", async () => {
  const r = await handleMcpMessage(makeCtx(), { jsonrpc: "2.0", id: 6, method: "resources/list" });
  assert.equal((r as any).error.code, -32601);
});

// --- MIME ---

test("buildMime setzt Header und base64-Body", () => {
  const mime = buildMime(
    { to: "k@example.com", from: "noreply@vonbusch.app", subject: "Angebot", text: "Hallo Welt", proposedBy: "a" },
    "abc123",
  );
  assert.match(mime, /^From: noreply@vonbusch\.app\r\n/);
  assert.match(mime, /\r\nTo: k@example\.com\r\n/);
  assert.match(mime, /\r\nSubject: Angebot\r\n/);
  assert.match(mime, /Message-ID: <abc123@vonbusch\.app>/);
  assert.match(mime, /Content-Transfer-Encoding: base64/);
  const body = mime.split("\r\n\r\n")[1].trim();
  assert.equal(Buffer.from(body, "base64").toString("utf-8"), "Hallo Welt");
});

test("encodeHeaderValue kodiert Nicht-ASCII (RFC 2047) und strippt Zeilenumbrüche", () => {
  assert.equal(encodeHeaderValue("Angebot"), "Angebot");
  assert.match(encodeHeaderValue("Grüße"), /^=\?UTF-8\?B\?/);
  assert.equal(encodeHeaderValue("a\r\nb"), "a b");
});
