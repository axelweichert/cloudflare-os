// Integration-Test: voller MCP-HTTP-Roundtrip durch den Mailbox-Pinning-Proxy.
//
// Startet einen echten HTTP-Mock-Upstream (Node http), schickt MCP-JSON-RPC durch
// handleMcpRequest und prueft:
//   - tools/list liefert die verengte Liste (cross-mailbox-Tools entfernt, inbox_id weg)
//   - tools/call injiziert die gepinnte Mailbox
//   - Fremd-Mailbox-Versuch wird als JSON-RPC-Error abgelehnt
//   - cross-mailbox-Tool-Versuch abgelehnt
//   - Passthrough (z.B. read-only Tool ohne inbox_id auf Allowlist) funktioniert
//
// Laeuft workerd-frei, kostenfrei:
//   npx tsx --test vonbusch/mailbox-gatekeeper/mcp-proxy-handler.test.ts

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { handleMcpRequest, emptySession, type ProxySession } from "./mcp-proxy-handler.ts";

// --- Fake-Upstream: agentic-inbox-artiges MCP-Server mit mehreren Mailboxen -----------------------

const FAKE_TOOLS = [
  {
    name: "send_message",
    description: "Send an email from an inbox.",
    inputSchema: {
      type: "object",
      properties: {
        inbox_id: { type: "string", description: "Mailbox ID" },
        to: { type: "string" },
        body: { type: "string" },
      },
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
    name: "get_server_status",
    description: "Read-only: health of the mail server (no inbox_id).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    // cross-mailbox, nicht verengbar
    name: "list_all_inboxes",
    description: "List all inboxes on the account.",
    inputSchema: { type: "object", properties: {} },
  },
];

function fakeUpstreamHandler(req: IncomingMessage, res: ServerResponse) {
  let body = "";
  req.on("data", c => { body += c; });
  req.on("end", () => {
    let rpc: { jsonrpc: string; id: unknown; method: string; params?: unknown };
    try { rpc = JSON.parse(body); } catch { res.writeHead(400).end(); return; }

    const reply = (result: unknown) => {
      const payload = JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result });
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Mcp-Session-Id": "fake-session-42",
      }).end(payload);
    };

    if (rpc.method === "initialize") {
      reply({ protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "agentic-inbox-mock", version: "1" } });
    } else if (rpc.method === "notifications/initialized") {
      res.writeHead(202).end();
    } else if (rpc.method === "tools/list") {
      reply({ tools: FAKE_TOOLS });
    } else if (rpc.method === "tools/call") {
      const p = rpc.params as { name?: string; arguments?: Record<string, unknown> };
      // Upstream echot die Argumente zurueck (fuer den Test pruefbar).
      reply({ content: [{ type: "text", text: JSON.stringify({ calledTool: p?.name, args: p?.arguments }) }] });
    } else {
      const errPayload = JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } });
      res.writeHead(200, { "Content-Type": "application/json" }).end(errPayload);
    }
  });
}

// -------------------------------------------------------------------------------------------------

const PINNED = "inbox_ceo@vonbusch.digital";
let upstreamUrl: string;
let server: ReturnType<typeof createServer>;

before(async () => {
  server = createServer(fakeUpstreamHandler);
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  upstreamUrl = `http://127.0.0.1:${addr.port}/mcp`;
});

after(() => new Promise<void>(r => server.close(() => r())));

function mkRequest(body: unknown, sessionId?: string): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  return new Request("http://proxy.local/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function jsonRpc(body: unknown, session: ProxySession, cfg = { mailbox: PINNED, passthroughTools: ["get_server_status"] }) {
  const res = await handleMcpRequest(
    mkRequest(body),
    upstreamUrl,
    { ...cfg, mailbox: PINNED },
    session,
  );
  return res;
}

async function parse(res: Response) {
  const text = await res.text();
  return JSON.parse(text);
}

test("initialize: Upstream-Session wird eroeffnet, Serverinfo weitergeleitet", async () => {
  const session = emptySession();
  const res = await jsonRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, session);
  assert.equal(res.status, 200);
  const body = await parse(res);
  assert.ok(!body.error, `Unerwarteter Fehler: ${body.error?.message}`);
  assert.equal(body.result.serverInfo.name, "agentic-inbox-mock");
  assert.equal(session.upstreamSessionId, "fake-session-42", "Upstream-Session-ID muss gespeichert werden");
});

test("tools/list: cross-mailbox-Tool entfernt, inbox_id aus Schema weg", async () => {
  const session = emptySession();
  const res = await jsonRpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, session);
  const body = await parse(res);
  assert.ok(!body.error, body.error?.message);
  const tools: { name: string; inputSchema?: { properties?: Record<string, unknown> } }[] = body.result.tools;
  const names = tools.map(t => t.name).sort();
  assert.ok(!names.includes("list_all_inboxes"), "cross-mailbox-Tool darf nicht erscheinen");
  assert.ok(names.includes("send_message"), "mailbox-Tool muss erscheinen");
  assert.ok(names.includes("get_server_status"), "Passthrough-Tool muss erscheinen");
  const send = tools.find(t => t.name === "send_message")!;
  assert.ok(!(send.inputSchema?.properties && "inbox_id" in send.inputSchema.properties),
    "inbox_id darf im beworbenen Schema nicht erscheinen");
});

test("tools/call: Mailbox wird automatisch injiziert", async () => {
  const session = emptySession();
  const res = await jsonRpc({
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "send_message", arguments: { to: "x@example.com", body: "hallo" } },
  }, session);
  const body = await parse(res);
  assert.ok(!body.error, body.error?.message);
  const echoed = JSON.parse(body.result.content[0].text);
  assert.equal(echoed.args.inbox_id, PINNED, "Proxy muss die gepinnte Mailbox injizieren");
  assert.equal(echoed.args.to, "x@example.com", "andere Argumente muessen unveraendert ankommen");
});

test("tools/call: Fremd-Mailbox-Versuch wird verweigert (Kern-Gate)", async () => {
  const session = emptySession();
  const res = await jsonRpc({
    jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "list_messages", arguments: { inbox_id: "inbox_opfer@vonbusch.digital" } },
  }, session);
  const body = await parse(res);
  assert.ok(body.error, "Fremd-Mailbox muss JSON-RPC-Fehler erzeugen");
  assert.match(body.error.message, /fremde Mailbox/, "Fehlertext muss auf fremde Mailbox hinweisen");
});

test("tools/call: cross-mailbox-Tool abgelehnt (auch wenn direkt versucht)", async () => {
  const session = emptySession();
  const res = await jsonRpc({
    jsonrpc: "2.0", id: 5, method: "tools/call",
    params: { name: "list_all_inboxes", arguments: {} },
  }, session);
  const body = await parse(res);
  assert.ok(body.error, "cross-mailbox-Tool muss JSON-RPC-Fehler erzeugen");
  assert.match(body.error.message, /nicht freigegeben|nicht verengbar/);
});

test("tools/call: Passthrough-Tool (get_server_status) funktioniert unveraendert", async () => {
  const session = emptySession();
  const res = await jsonRpc({
    jsonrpc: "2.0", id: 6, method: "tools/call",
    params: { name: "get_server_status", arguments: {} },
  }, session);
  const body = await parse(res);
  assert.ok(!body.error, body.error?.message);
  const echoed = JSON.parse(body.result.content[0].text);
  assert.equal(echoed.calledTool, "get_server_status");
  assert.ok(!echoed.args.inbox_id, "Passthrough-Tool bekommt kein inbox_id injiziert");
});

test("gepinnte Mailbox im Argument wird durchgereicht (kein Doppelpin)", async () => {
  const session = emptySession();
  const res = await jsonRpc({
    jsonrpc: "2.0", id: 7, method: "tools/call",
    params: { name: "list_messages", arguments: { inbox_id: PINNED } },
  }, session);
  const body = await parse(res);
  assert.ok(!body.error, body.error?.message);
  const echoed = JSON.parse(body.result.content[0].text);
  assert.equal(echoed.args.inbox_id, PINNED);
});
