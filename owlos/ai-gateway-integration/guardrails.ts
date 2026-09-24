// vonBuschOS — AI-Gateway-Integration: Guardrail-/DLP-Policy (VON-1806 / K8)
//
// Guardrails (Prompt-/Response-Safety + DLP) laufen SERVERSEITIG auf dem AI Gateway und werden
// pro Gateway konfiguriert (Dashboard/CF-API), nicht im CF-OS-Code. Dieses Modul beschreibt die
// von-Busch-Policy als versionierten Descriptor (Single Source of Truth für die CEO-seitige
// Gateway-Konfiguration) und liefert einen Interpreter, der eine geblockte/geflaggte
// Gateway-Antwort in eine saubere Meldung übersetzt, statt Agenten einen rohen 4xx zu zeigen.
//
// LEHRE aus VON-157 (CRM): Finanzdaten dürfen NICHT hart geblockt werden — ein BLOCK-DLP-Profil
// auf Finanzinformationen brach die CRM-KI-Analyse (HTTP 424). Finanz-Kategorie steht hier
// deshalb bewusst auf FLAG (loggen/markieren), nicht BLOCK.
//
// Kein cloudflare:workers-Import → in Node testbar.

export type GuardrailAction = "block" | "flag" | "off";
export type GuardrailScope = "prompt" | "response" | "both";

export interface GuardrailRule {
  /** Kategorie-Id, wie sie das Gateway kennt (Guardrails/DLP-Kategorie). */
  category: string;
  action: GuardrailAction;
  scope: GuardrailScope;
  note?: string;
}

/**
 * von-Busch-Standard-Policy für `vonbusch-aigateway`.
 * BLOCK nur für klar schädliche Kategorien; PII/Finanz auf FLAG (siehe VON-157), damit
 * legitime Geschäfts-Workflows (CRM-Analyse, Angebote) nicht abbrechen.
 */
export const VONBUSCH_GUARDRAIL_POLICY: { version: string; rules: GuardrailRule[] } = {
  version: "2026-08-25",
  rules: [
    { category: "hate", action: "block", scope: "both" },
    { category: "violence", action: "block", scope: "both" },
    { category: "sexual", action: "block", scope: "both" },
    { category: "self-harm", action: "block", scope: "both" },
    { category: "prompt-injection", action: "flag", scope: "prompt" },
    // DLP: markieren, nicht blocken — sonst brechen Finanz-/CRM-Workflows (VON-157).
    { category: "pii", action: "flag", scope: "both", note: "PII markieren, nicht blocken." },
    { category: "financial", action: "flag", scope: "both", note: "VON-157: kein BLOCK auf Finanzdaten." },
    { category: "credentials", action: "block", scope: "both", note: "Secrets/API-Keys nie durchreichen." },
  ],
};

export interface GuardrailOutcome {
  /** true, wenn das Gateway den Request/Response wegen einer block-Kategorie abgewiesen hat. */
  blocked: boolean;
  /** true, wenn (nur) geflaggt wurde — Request lief durch, ist aber markiert. */
  flagged: boolean;
  /** Betroffene Kategorie(n), sofern das Gateway sie meldet. */
  categories: string[];
  /** Menschlich lesbare Meldung für den aufrufenden Agenten. */
  message?: string;
}

/**
 * Interpretiert das Guardrail-Signal einer Gateway-Antwort.
 *
 * Kontrakt (AI-Gateway-Guardrails): eine durch BLOCK abgewiesene Anfrage kommt als Fehler mit
 * Status 4xx (typ. 400/403/424) zurück und trägt einen Guardrail-Hinweis im Body/Header;
 * FLAG lässt den Request durch (2xx) und markiert ihn (Header/Log). Wir lesen bewusst tolerant:
 * Status + optionaler `cf-aig-*`-Header + optionales Body-Objekt. Bei Anpassung an das reale
 * Signal genügt es, die Erkennungsheuristik hier zu justieren — die Aufrufer bleiben stabil.
 */
export function interpretGuardrailOutcome(input: {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}): GuardrailOutcome {
  const headers = normalizeHeaders(input.headers);
  const flaggedHeader = headers["cf-aig-guardrail"] ?? headers["cf-aig-guardrails"];
  const categories = extractCategories(input.body, flaggedHeader);

  // BLOCK: 4xx mit Guardrail-Signal (Header oder Body-Marker).
  const hasSignal = Boolean(flaggedHeader) || isGuardrailBody(input.body);
  if (input.status >= 400 && hasSignal) {
    return {
      blocked: true,
      flagged: false,
      categories,
      message:
        `Anfrage durch Guardrail abgewiesen${categories.length ? ` (Kategorie: ${categories.join(", ")})` : ""}. ` +
        `Formuliere die Anfrage ohne die beanstandeten Inhalte neu.`,
    };
  }

  // FLAG: durchgelaufen (2xx), aber markiert.
  if (input.status < 400 && (flaggedHeader === "flagged" || (hasSignal && categories.length > 0))) {
    return {
      blocked: false,
      flagged: true,
      categories,
      message: `Anfrage lief durch, wurde aber markiert (${categories.join(", ") || "guardrail"}).`,
    };
  }

  return { blocked: false, flagged: false, categories: [] };
}

function normalizeHeaders(h?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

function isGuardrailBody(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const b = body as Record<string, unknown>;
  if (typeof b.error === "object" && b.error) {
    const e = b.error as Record<string, unknown>;
    const type = typeof e.type === "string" ? e.type.toLowerCase() : "";
    const msg = typeof e.message === "string" ? e.message.toLowerCase() : "";
    if (type.includes("guardrail") || msg.includes("guardrail")) return true;
  }
  return "guardrail" in b || "guardrails" in b;
}

function extractCategories(body: unknown, header?: string): string[] {
  const cats = new Set<string>();
  if (header && header !== "flagged" && header !== "blocked") {
    for (const c of header.split(",").map((s) => s.trim()).filter(Boolean)) cats.add(c);
  }
  if (body && typeof body === "object") {
    const g = (body as Record<string, unknown>).guardrail ?? (body as Record<string, unknown>).guardrails;
    if (g && typeof g === "object") {
      const c = (g as Record<string, unknown>).categories ?? (g as Record<string, unknown>).category;
      if (Array.isArray(c)) c.forEach((x) => typeof x === "string" && cats.add(x));
      else if (typeof c === "string") cats.add(c);
    }
  }
  return [...cats];
}
