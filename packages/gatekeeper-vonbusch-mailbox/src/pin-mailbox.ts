// vonBuschOS — Mailbox-Pinning für MCP (VON-1798, Stufe 3/4-Gate)
//
// Problem (siehe docs/vonbusch/VON-1798-security-review.md):
//   agentic-inbox (AgentMail-artig) exponiert unter /mcp Tools, die eine Mailbox/Inbox als
//   ARGUMENT (z.B. `inbox_id`) tragen, plus mailbox-uebergreifende Tools ("list all inboxes"/
//   "list threads in all inboxes"). Der generische gatekeeper-mcp verengt Grants ausschliesslich
//   ueber TOOL-NAMEN (`scope.tools`) — nie ueber Tool-ARGUMENTE. Named-Tool-Scoping laesst also
//   die Auswahl der Mailbox frei => /mcp exponiert effektiv alle Mailboxen.
//
// Diese Schicht schliesst die Luecke: ein duenner MCP-Proxy, der auf GENAU EINE Mailbox pinnt.
// Sie sitzt zwischen gatekeeper-mcp (liefert HITL-Approval + Observation-Audit) und dem
// agentic-inbox /mcp. Protokoll-geformt (JSON-RPC MCP `tools/list` / `tools/call`), damit sie
// unveraendert in einen Cloudflare Worker gehoben werden kann, den der gatekeeper als Endpoint
// verbindet.
//
// Prinzip: FAIL-CLOSED. Nur explizit als mailbox-gebunden erkannte Tools (oder eine
// Passthrough-Allowlist) werden durchgereicht; alles andere wird verweigert.

/** Minimale MCP-Wire-Typen (Teilmenge von @gadgets/mcp-shared/client). */
export type JsonSchema = {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [k: string]: unknown;
};

export type McpTool = {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
};

export type ToolCallResult = {
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  isError?: boolean;
};

/** Strukturiertes Audit-Ereignis, das der Proxy an den Aufrufer emittiert. */
export type AuditEvent = {
  event: "list" | "call.forwarded" | "call.refused";
  tool?: string;
  mailbox: string;
  reason?: string;
};

export type PinConfig = {
  /** Die eine Mailbox/Inbox, auf die dieser Proxy verengt (Wire-Wert, z.B. Inbox-ID). */
  mailbox: string;
  /** Name des Mailbox-Arguments im inputSchema der Upstream-Tools. Default: "inbox_id". */
  mailboxParam?: string;
  /**
   * Tools ohne Mailbox-Argument, die trotzdem durchgereicht werden duerfen (z.B. reine
   * Health-/Metadaten-Tools). Standardmaessig leer => solche Tools werden verweigert (fail-closed).
   */
  passthroughTools?: string[];
  /** Optionaler Audit-Sink. */
  audit?: (e: AuditEvent) => void;
};

const DEFAULT_PARAM = "inbox_id";

/** True, wenn das Tool die gepinnte Mailbox als Argument fuehrt (=> pinnbar). */
export function isMailboxScoped(tool: McpTool, param: string): boolean {
  return Boolean(tool.inputSchema?.properties && param in tool.inputSchema.properties);
}

type Access = "pinned" | "passthrough";

type Decision =
  | { kind: Access }
  | { kind: "refused"; reason: string };

function decide(tool: McpTool, cfg: Required<Pick<PinConfig, "mailboxParam">> & PinConfig): Decision {
  const passthrough = new Set(cfg.passthroughTools ?? []);
  if (isMailboxScoped(tool, cfg.mailboxParam)) return { kind: "pinned" };
  if (passthrough.has(tool.name)) return { kind: "passthrough" };
  // Fail-closed: mailbox-uebergreifende oder unklassifizierte Tools werden verweigert, weil sie
  // sich nicht auf eine Mailbox verengen lassen.
  return {
    kind: "refused",
    reason: `Tool "${tool.name}" traegt kein "${cfg.mailboxParam}"-Argument und ist nicht auf der ` +
      `Passthrough-Allowlist; auf eine Mailbox nicht verengbar.`,
  };
}

/**
 * Der Ausfuehrungsplan des Proxys fuer eine Verbindung: die (verengte) Tool-Liste, die dem
 * gatekeeper beworben wird, plus die Zugriffsart je freigegebenem Tool. Die Entscheidung ruht auf
 * dem UPSTREAM-Schema und wird EINMAL getroffen — nicht spaeter aus der beworbenen (bereits
 * beschnittenen) Liste re-abgeleitet, sonst faellt das gepinnte Feld faelschlich als "unbekannt".
 */
export type PinPlan = {
  advertised: McpTool[];
  access: Map<string, Access>;
};

/**
 * Baut den Pin-Plan aus dem Upstream-Tool-Katalog:
 *  - verweigerte Tools werden entfernt,
 *  - bei pinnbaren Tools wird das Mailbox-Argument aus dem beworbenen Schema entfernt (der Agent
 *    darf/kann die Mailbox nicht mehr waehlen), und ein Hinweis an die Beschreibung gehaengt.
 */
export function buildPinPlan(tools: McpTool[], config: PinConfig): PinPlan {
  const cfg = { mailboxParam: DEFAULT_PARAM, ...config };
  const advertised: McpTool[] = [];
  const access = new Map<string, Access>();
  for (const tool of tools) {
    const decision = decide(tool, cfg);
    if (decision.kind === "refused") continue;
    access.set(tool.name, decision.kind);
    if (decision.kind === "passthrough") {
      advertised.push(tool);
      continue;
    }
    // pinned: Mailbox-Feld aus dem Schema herausschneiden.
    const props = { ...(tool.inputSchema?.properties ?? {}) };
    delete props[cfg.mailboxParam];
    const required = (tool.inputSchema?.required ?? []).filter(r => r !== cfg.mailboxParam);
    advertised.push({
      ...tool,
      description:
        (tool.description ? tool.description + " " : "") +
        `(vonBuschOS: fest auf Mailbox "${cfg.mailbox}" verengt.)`,
      inputSchema: { ...(tool.inputSchema ?? {}), properties: props, required },
    });
  }
  config.audit?.({
    event: "list",
    mailbox: cfg.mailbox,
    reason: `${advertised.length}/${tools.length} Tools freigegeben`,
  });
  return { advertised, access };
}

/** Bequemer Zugriff auf nur die beworbene `tools/list`. */
export function narrowToolList(tools: McpTool[], config: PinConfig): McpTool[] {
  return buildPinPlan(tools, config).advertised;
}

/** Ergebnis der Vorpruefung eines `tools/call`, bevor an den Upstream weitergereicht wird. */
export type CallGate =
  | { allowed: true; args: Record<string, unknown> }
  | { allowed: false; result: ToolCallResult };

/**
 * Erzwingt die Mailbox-Verengung fuer einen `tools/call`:
 *  1. Nicht freigegebenes Tool  -> verweigert.
 *  2. Fremde Mailbox im Argument -> verweigert (Angriffsversuch, auditiert).
 *  3. Sonst: Mailbox-Argument wird auf den gepinnten Wert ueberschrieben (auch wenn der Client es
 *     weggelassen hat), dann Freigabe.
 * Gibt nur die (ggf. korrigierten) Argumente zurueck; der eigentliche Upstream-Call bleibt beim
 * Aufrufer (Worker/Transport), damit dieses Modul transport-frei und testbar bleibt.
 */
export function gateToolCall(
  toolName: string,
  args: Record<string, unknown>,
  plan: PinPlan,
  config: PinConfig,
): CallGate {
  const cfg = { mailboxParam: DEFAULT_PARAM, ...config };
  const refuse = (reason: string): CallGate => {
    config.audit?.({ event: "call.refused", tool: toolName, mailbox: cfg.mailbox, reason });
    return { allowed: false, result: { isError: true, content: [{ type: "text", text: reason }] } };
  };

  const access = plan.access.get(toolName);
  if (access === undefined) {
    return refuse(`Tool "${toolName}" ist ueber diese Mailbox-Verengung nicht freigegeben.`);
  }

  if (access === "pinned") {
    const supplied = args[cfg.mailboxParam];
    if (supplied !== undefined && String(supplied) !== cfg.mailbox) {
      return refuse(
        `Zugriff auf fremde Mailbox "${String(supplied)}" verweigert; diese Verbindung ist auf ` +
        `"${cfg.mailbox}" verengt.`);
    }
    const pinnedArgs = { ...args, [cfg.mailboxParam]: cfg.mailbox };
    config.audit?.({ event: "call.forwarded", tool: toolName, mailbox: cfg.mailbox });
    return { allowed: true, args: pinnedArgs };
  }

  // passthrough
  config.audit?.({ event: "call.forwarded", tool: toolName, mailbox: cfg.mailbox });
  return { allowed: true, args };
}
