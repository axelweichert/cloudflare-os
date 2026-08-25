// K1 -- docking the von Busch "agentic-inbox" MCP server through the generic MCP gatekeeper.
//
// agentic-inbox (fork of cloudflare/agentic-inbox, deployed at mail.vonbusch.app) exposes a
// Streamable HTTP MCP endpoint at `/mcp` with the 13 tools listed below. This gatekeeper connects
// *any* MCP server by URL, so docking it needs no agentic-inbox-specific code -- but two properties
// have to hold for the dock to be usable, and both are asserted here from the server's real surface:
//
//   1. Every one of its tools becomes a callable, correctly-named method on the generated session
//      (the `.d.ts` the agent sees and the object it is handed must agree -- see
//      `session-methods-e2e.test.ts` for the general invariant).
//   2. The read/action split the gatekeeper applies to a `byo` (user-pasted) endpoint matches what
//      the server actually declares. agentic-inbox publishes NO tool annotations today, so under
//      fail-closed `byo` classification EVERY tool -- including pure reads like `list_emails` -- is
//      an action that queues for Overseer approval. This test pins that reality and the fix:
//      annotating the read tools `readOnlyHint: true` upstream turns them into auto-observations.
//
// Cost-neutral: no network, no deploy, no live handshake -- it drives the same classification and
// type-generation path the running gatekeeper uses.

import { describe, expect, it } from "vitest";

import { generateSessionTypes } from "@gadgets/mcp-shared/schema-to-ts";
import { classifyTool } from "@gadgets/mcp-shared/tools";

import { serverIdFromEndpoint } from "../src/server-id.js";

// The demo deployment. serverId is display-only (`server-id.ts`); the action-kind tag uses the whole
// endpoint, so `mail` here is fine even though it is not a service name.
const ENDPOINT = "https://mail.vonbusch.app/mcp";

// agentic-inbox's real tool surface (workers/mcp/index.ts in vonbusch-app-agentic-inbox), split by
// what each tool actually does. `read` tools only return data; everything else mutates a mailbox.
const READ_TOOLS = ["list_mailboxes", "list_emails", "get_email", "get_thread", "search_emails"];
const ACTION_TOOLS = ["draft_reply", "create_draft", "update_draft", "delete_email", "send_reply",
                      "send_email", "mark_email_read", "move_email"];
const ALL_TOOLS = [...READ_TOOLS, ...ACTION_TOOLS];

// snake_case tool name -> the camelCase method the generator promises.
const EXPECTED_METHODS = [
  "listMailboxes", "listEmails", "getEmail", "getThread", "searchEmails",
  "draftReply", "createDraft", "updateDraft", "deleteEmail", "sendReply",
  "sendEmail", "markEmailRead", "moveEmail",
];

// Names the session type/binding owns and never generates a tool method for.
const RESERVED = ["listTools", "callTool", "getActionResult"];

function promisedMethods(dts: string): string[] {
  return [...dts.matchAll(/^ {2}([a-z]\w*)\(/gm)].map(m => m[1]).filter(n => !RESERVED.includes(n));
}

describe("agentic-inbox docks through the generic MCP gatekeeper (K1)", () => {
  it("derives a stable binding name from the demo endpoint", () => {
    // `mail.vonbusch.app` -> `mail` -> the agent is offered `env.MCP_MAIL`.
    expect(serverIdFromEndpoint(ENDPOINT)).toBe("mail");
  });

  it("current reality: no upstream annotations -> every tool is approval-queued", () => {
    const classified = ALL_TOOLS.map(name => classifyTool({ name } as never, "byo"));

    // Not one tool auto-resolves: reads and writes alike are actions. This is the dock's UX cost
    // today -- opening a mailbox prompts the Overseer for approval on a `list_emails`.
    expect(classified.every(c => c.mode === "action")).toBe(true);
    expect(classified.every(c => c.classifiedBy === "default")).toBe(true);
    expect(classified.some(c => c.autoApprovable)).toBe(false);
  });

  it("recommended fix: annotating the read tools upstream makes them observations", () => {
    const reads = READ_TOOLS.map(name =>
      classifyTool({ name, annotations: { readOnlyHint: true } } as never, "byo"));
    const actions = ACTION_TOOLS.map(name => classifyTool({ name } as never, "byo"));

    // Reads return straight away and are recorded as observations; writes still queue.
    expect(reads.every(c => c.mode === "read")).toBe(true);
    expect(reads.every(c => c.classifiedBy === "server-annotation")).toBe(true);
    expect(actions.every(c => c.mode === "action")).toBe(true);

    // `byo` never auto-*applies* a write, no matter what the server claims -- the tier's guarantee.
    expect(actions.some(c => c.autoApprovable)).toBe(false);
  });

  it("the generated session promises exactly one correctly-named method per tool", () => {
    const tools = ALL_TOOLS.map(name => classifyTool({ name } as never, "byo"));

    const dts = generateSessionTypes({
      baseTypes: "", serverId: "mail", serverName: "Mail",
      endpoint: ENDPOINT, discriminator: ENDPOINT, trust: "byo", tools,
    });

    // The .d.ts is the only description of this binding the agent sees. It must promise exactly the
    // 13 camelCased methods -- nothing dropped, nothing invented -- since every name here is a clean
    // snake_case identifier with no collisions. (`installToolMethods` really installs each promised
    // method; that invariant is proven generically in mcp-shared's session-methods-e2e test.)
    expect(promisedMethods(dts).toSorted()).toEqual(EXPECTED_METHODS.toSorted());

    // Every write is also reachable by its exact wire name, for calls a method name cannot carry.
    for (const write of ACTION_TOOLS) {
      expect(dts).toContain(`callTool(name: ${JSON.stringify(write)}`);
    }
  });
});
