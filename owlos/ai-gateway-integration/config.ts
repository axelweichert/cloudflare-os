// vonBuschOS — AI-Gateway-Integration: Konfigurations-Wiring (VON-1806 / K8)
//
// Cloudflare OS routet LLM-Requests NATIV über Cloudflare AI Gateway, sobald die
// CF_AI_GATEWAY_*-Env-Variablen gesetzt sind (siehe packages/workshop-backend/src/ai-models.ts
// getModelViaGateway + packages/workshop-backend/src/env.d.ts). K8 besteht darin, genau diese
// native Konfiguration auf UNSER Gateway `vonbusch-aigateway` zu richten — damit greifen dessen
// serverseitige Kostenkontrolle, Rate-/Spend-Limits und DLP-Guardrails ohne Core-Änderung.
//
// Dieses Modul kodiert das Wiring als GETESTETEN Code statt als bloße Prosa: es baut den
// Env-Block und validiert dieselben Invarianten, die der `AiGatewayConfig`-Konstruktor von
// CF-OS zur Laufzeit erzwingt (Account-ID Pflicht mit Gateway; Token Pflicht für den
// HTTPS-Transport / für Google). So fällt Fehlkonfiguration in CI auf, nicht erst im Deploy.
//
// Kein cloudflare:workers-Import → in Node testbar (npx tsx --test).

/** Unser Cloudflare-AI-Gateway (NFR-Account, Prefix 6d2a1d59…). */
export const VONBUSCH_GATEWAY_NAME = "vonbusch-aigateway";

/** Provider, die CF-OS über das Gateway mit serverseitig verwalteten Keys routen kann. */
export type GatewayProvider = "anthropic" | "openai" | "google" | "cloudflare";

/** Providers, für die auf `vonbusch-aigateway` echte 200er verifiziert sind (VON-227). */
export const VONBUSCH_DEFAULT_PROVIDERS: GatewayProvider[] = ["anthropic", "openai"];

const ALL_PROVIDERS: GatewayProvider[] = ["anthropic", "openai", "google", "cloudflare"];

/** Der Env-Ausschnitt, den CF-OS (workshop-backend) für den Gateway-Modus liest. */
export interface GatewayEnv {
  CF_AI_GATEWAY: string;
  CF_AI_GATEWAY_ACCOUNT_ID: string;
  CF_AI_GATEWAY_PROVIDERS: string;
  /** Run+Read-Token. Optional NUR, wenn der Binding-Transport aktiv ist und kein Google. */
  CF_AI_GATEWAY_API_TOKEN?: string;
  /** "false" erzwingt den HTTPS-Transport (statt der Workers-AI-Binding). */
  CF_AI_GATEWAY_USE_BINDING?: string;
}

export interface BuildGatewayEnvOptions {
  /** Volle 32-hex CF-Account-ID des NFR-Accounts (Prefix 6d2a1d59…). */
  accountId: string;
  providers?: GatewayProvider[];
  /** Run+Read-API-Token des Gateways (als Secret gesetzt). */
  apiToken?: string;
  /** true (Default) nutzt die Workers-AI-Binding wo möglich, sonst HTTPS. */
  useBinding?: boolean;
}

const HEX32 = /^[0-9a-f]{32}$/;

/** Baut den CF_AI_GATEWAY_*-Env-Block für `vonbusch-aigateway`. Wirft bei ungültiger Account-ID. */
export function buildGatewayEnv(opts: BuildGatewayEnvOptions): GatewayEnv {
  const accountId = opts.accountId.trim().toLowerCase();
  if (!HEX32.test(accountId)) {
    throw new Error(
      `CF_AI_GATEWAY_ACCOUNT_ID muss eine 32-stellige Hex-Account-ID sein (NFR-Account, Prefix 6d2a1d59…), erhalten: "${opts.accountId}".`,
    );
  }
  const providers = opts.providers ?? VONBUSCH_DEFAULT_PROVIDERS;
  if (providers.length === 0) throw new Error("Mindestens ein Provider erforderlich.");
  for (const p of providers) {
    if (!ALL_PROVIDERS.includes(p)) throw new Error(`Unbekannter Provider: "${p}".`);
  }
  const env: GatewayEnv = {
    CF_AI_GATEWAY: VONBUSCH_GATEWAY_NAME,
    CF_AI_GATEWAY_ACCOUNT_ID: accountId,
    CF_AI_GATEWAY_PROVIDERS: providers.join(","),
  };
  if (opts.apiToken) env.CF_AI_GATEWAY_API_TOKEN = opts.apiToken;
  if (opts.useBinding === false) env.CF_AI_GATEWAY_USE_BINDING = "false";
  return env;
}

export interface ValidationIssue {
  field: string;
  message: string;
}

/**
 * Prüft dieselben Invarianten, die CF-OS zur Laufzeit erzwingt, BEVOR deployt wird:
 *  - Account-ID Pflicht & wohlgeformt, sobald ein Gateway gesetzt ist.
 *  - Provider-Liste nicht leer & nur bekannte Provider.
 *  - API-Token Pflicht, wenn der HTTPS-Transport aktiv ist (USE_BINDING=false) ODER Google
 *    unter den Providern ist (Google reitet immer HTTPS und braucht den Gateway-Token).
 * `parsedProviders` liegt aus Bequemlichkeit bei.
 */
export function validateGatewayEnv(env: Partial<GatewayEnv>): {
  ok: boolean;
  issues: ValidationIssue[];
  parsedProviders: GatewayProvider[];
} {
  const issues: ValidationIssue[] = [];
  const providers = (env.CF_AI_GATEWAY_PROVIDERS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as GatewayProvider[];

  if (!env.CF_AI_GATEWAY) {
    issues.push({ field: "CF_AI_GATEWAY", message: "Gateway-Name fehlt (kein Gateway-Modus)." });
  }
  const acct = (env.CF_AI_GATEWAY_ACCOUNT_ID ?? "").trim().toLowerCase();
  if (!acct) {
    issues.push({ field: "CF_AI_GATEWAY_ACCOUNT_ID", message: "Account-ID ist mit gesetztem Gateway Pflicht." });
  } else if (!HEX32.test(acct)) {
    issues.push({ field: "CF_AI_GATEWAY_ACCOUNT_ID", message: "Account-ID ist keine 32-hex-ID." });
  }
  if (providers.length === 0) {
    issues.push({ field: "CF_AI_GATEWAY_PROVIDERS", message: "Mindestens ein Provider erforderlich." });
  }
  for (const p of providers) {
    if (!ALL_PROVIDERS.includes(p)) {
      issues.push({ field: "CF_AI_GATEWAY_PROVIDERS", message: `Unbekannter Provider: "${p}".` });
    }
  }
  const httpsTransport = env.CF_AI_GATEWAY_USE_BINDING === "false";
  const needsToken = httpsTransport || providers.includes("google");
  if (needsToken && !env.CF_AI_GATEWAY_API_TOKEN) {
    issues.push({
      field: "CF_AI_GATEWAY_API_TOKEN",
      message: httpsTransport
        ? "HTTPS-Transport (USE_BINDING=false) verlangt ein Run+Read-Token."
        : "Provider 'google' reitet immer HTTPS und verlangt den Gateway-Token.",
    });
  }
  return { ok: issues.length === 0, issues, parsedProviders: providers };
}
