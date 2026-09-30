// owlOS — Etsy-Gatekeeper: OAuth-2.0-Authorize-Flow mit PKCE (OWL-1744, Elternticket OWL-1743)
//
// Zwei Routen (hinter CF Access, Wiring-Werkzeug fuer EINEN Menschen, kein oeffentlicher Endpunkt):
//   GET /oauth/start     — PKCE-Paar erzeugen, code_verifier + state serverseitig (KV) ablegen,
//                          302 auf Etsys Authorize-URL (response_type=code, S256).
//   GET /oauth/callback  — state pruefen (CSRF, Einmal-Charakter), Code + code_verifier gegen den
//                          Token-Endpoint tauschen, Refresh-Token via bestehenden TokenManager/
//                          KvTokenStore ins KV, schlichte Erfolgsseite.
//
// Sicherheits-Invarianten:
//   - PKCE: code_verifier kryptografisch zufaellig, code_challenge = base64url(SHA-256(verifier)),
//     code_challenge_method=S256.
//   - state gegen CSRF: erzeugt, kurzlebig (KV-TTL) gespeichert, im Callback geprueft, danach
//     verworfen. Falscher/fehlender state → Ablehnung.
//   - Einmal-Charakter: nach dem Tausch ist der state verbraucht; ein zweiter Callback mit
//     demselben state schlaegt fehl (take() loescht den Eintrag).
//   - KEIN Geheimnis (code_verifier, code, Token) landet je in URL oder Log. Diese Datei loggt nichts.
//
// Voll testbar ohne workerd/Netz: PKCE nutzt globales `crypto` (WebCrypto, in workerd wie in Node),
// der Token-Tausch laeuft ueber eine injizierte Exchange-Funktion (TokenManager, Fake-fetch in Tests).

// Exakt die abgenommenen Scopes (OWL-1740 Security-Review) — nicht mehr.
export const ETSY_SCOPES = "shops_r listings_r transactions_r listings_w transactions_w";

// Etsys Authorize-Seite (Nutzer-Zustimmung). NICHT der Token-Endpoint (der liegt auf api.etsy.com).
export const DEFAULT_AUTHORIZE_ENDPOINT = "https://www.etsy.com/oauth/connect";

// KV-TTL fuer eine offene Autorisierung. Kurz genug fuer Einmal-Charakter, lang genug fuer den
// menschlichen Klick-Weg ("Erlauben"). Etsy-Codes sind ohnehin sehr kurzlebig.
const STATE_TTL_SECONDS = 600;

// ---------------------------------------------------------------------------
// PKCE / Zufalls-Helfer (WebCrypto — kein Node-only-Import).

/** base64url ohne Padding (RFC 7636 §A). */
export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 32 kryptografisch zufaellige Bytes → 43-Zeichen base64url (gueltiger PKCE-Verifier). */
export function generateCodeVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/** Kurzlebiges, unratbares CSRF-`state`. */
export function generateState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/** code_challenge = base64url(SHA-256(verifier)) — S256. */
export async function computeCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

/** Baut die Etsy-Authorize-URL. `scopes` als Leerzeichen-getrennte Liste. */
export function buildAuthorizeUrl(opts: {
  authorizeEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(opts.authorizeEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("scope", opts.scopes);
  url.searchParams.set("state", opts.state);
  url.searchParams.set("code_challenge", opts.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

// ---------------------------------------------------------------------------
// Kurzlebiger Transaktions-Store (state → code_verifier) mit Einmal-Charakter.

/** Minimales KV-Interface inkl. TTL + delete (workerd KVNamespace erfuellt es; Fake in Tests). */
export interface OAuthKv {
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface OAuthStateStore {
  /** Legt `state → code_verifier` kurzlebig ab. */
  save(state: string, codeVerifier: string): Promise<void>;
  /** Liefert den code_verifier EINMALIG und loescht den Eintrag (Einmal-Charakter). */
  take(state: string): Promise<string | undefined>;
}

/** KV-gestuetzt: ein Schluessel pro offener Autorisierung, mit TTL. */
export class KvOAuthStateStore implements OAuthStateStore {
  constructor(
    private kv: OAuthKv,
    private ttlSeconds = STATE_TTL_SECONDS,
    private prefix = "oauth:txn:",
  ) {}
  private key(state: string): string {
    return this.prefix + state;
  }
  async save(state: string, codeVerifier: string): Promise<void> {
    await this.kv.put(this.key(state), JSON.stringify({ codeVerifier }), {
      expirationTtl: this.ttlSeconds,
    });
  }
  async take(state: string): Promise<string | undefined> {
    const raw = (await this.kv.get(this.key(state), "json")) as { codeVerifier?: string } | null;
    if (!raw || typeof raw.codeVerifier !== "string") return undefined;
    // Erst loeschen (Einmal-Charakter), dann den Wert zurueckgeben.
    await this.kv.delete(this.key(state));
    return raw.codeVerifier;
  }
}

/** In-Memory-Variante — deterministisch, fuer Tests. */
export class MemoryOAuthStateStore implements OAuthStateStore {
  private map = new Map<string, string>();
  async save(state: string, codeVerifier: string): Promise<void> {
    this.map.set(state, codeVerifier);
  }
  async take(state: string): Promise<string | undefined> {
    const v = this.map.get(state);
    if (v === undefined) return undefined;
    this.map.delete(state);
    return v;
  }
}

// ---------------------------------------------------------------------------
// Flow-Logik (workerd-frei; worker.ts wrappt sie nur mit Request/Response).

/** Tauscht Code+Verifier gegen Tokens und persistiert sie (i.d.R. TokenManager.exchangeAuthorizationCode). */
export type CodeExchanger = (args: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}) => Promise<{ expiresAt: number; scope?: string }>;

export interface StartResult {
  location: string;
}

/** GET /oauth/start — PKCE erzeugen, state/verifier ablegen, Ziel-URL fuer 302 liefern. */
export async function startAuthorize(deps: {
  clientId: string;
  authorizeEndpoint: string;
  redirectUri: string;
  scopes?: string;
  stateStore: OAuthStateStore;
  genVerifier?: () => string;
  genState?: () => string;
}): Promise<StartResult> {
  const codeVerifier = (deps.genVerifier ?? generateCodeVerifier)();
  const state = (deps.genState ?? generateState)();
  const codeChallenge = await computeCodeChallenge(codeVerifier);
  await deps.stateStore.save(state, codeVerifier);
  const location = buildAuthorizeUrl({
    authorizeEndpoint: deps.authorizeEndpoint,
    clientId: deps.clientId,
    redirectUri: deps.redirectUri,
    scopes: deps.scopes ?? ETSY_SCOPES,
    state,
    codeChallenge,
  });
  return { location };
}

export interface CallbackResult {
  status: number;
  html: string;
}

interface ParamBag {
  get(key: string): string | null;
}

/**
 * GET /oauth/callback — state pruefen (CSRF + Einmal), Code tauschen, Erfolgsseite.
 * Reihenfolge bewusst: state/code-Praesenz VOR dem Verbrauch pruefen, damit ein
 * fehlgeformter Callback den state nicht unnoetig verbrennt. Nach erfolgreichem Tausch
 * ist der state weg → ein zweiter Callback mit demselben state schlaegt fehl.
 */
export async function completeCallback(deps: {
  params: ParamBag;
  redirectUri: string;
  stateStore: OAuthStateStore;
  exchange: CodeExchanger;
}): Promise<CallbackResult> {
  const { params } = deps;

  const oauthError = params.get("error");
  if (oauthError) {
    const desc = params.get("error_description");
    return errorResult(
      400,
      "Etsy hat den Zugriff abgelehnt",
      desc ? `${oauthError}: ${desc}` : oauthError,
    );
  }

  const state = params.get("state") ?? "";
  if (!state) {
    return errorResult(400, "Fehlender state-Parameter", "Bitte den Vorgang ueber /oauth/start neu starten.");
  }
  const code = params.get("code") ?? "";
  if (!code) {
    return errorResult(400, "Fehlender code-Parameter", "Bitte den Vorgang ueber /oauth/start neu starten.");
  }

  const codeVerifier = await deps.stateStore.take(state);
  if (!codeVerifier) {
    return errorResult(
      400,
      "Ungueltiger oder abgelaufener state",
      "Der Vorgang ist abgelaufen, wurde bereits abgeschlossen, oder der state passt nicht. Bitte /oauth/start neu oeffnen.",
    );
  }

  let token: { expiresAt: number; scope?: string };
  try {
    token = await deps.exchange({ code, codeVerifier, redirectUri: deps.redirectUri });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return errorResult(502, "Token-Tausch fehlgeschlagen", msg);
  }

  return successResult(token);
}

// ---------------------------------------------------------------------------
// HTML (schlicht, deutsch, kein Build). Enthaelt bewusst KEIN Token/Code/Verifier.

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function page(title: string, bodyInner: string): string {
  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · owlOS Etsy-Gatekeeper</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 620px; margin: 0 auto; padding: 48px 24px; background: #f5f5f5; color: #1a1a1a; }
  .card { background: #fff; border-radius: 8px; padding: 24px 28px; box-shadow: 0 1px 3px rgba(0,0,0,.1); }
  h1 { font-size: 20px; margin: 0 0 12px; }
  p { line-height: 1.5; } .muted { color: #666; font-size: 14px; }
  .ok { color: #16a34a; } .err { color: #dc2626; }
  code { background: #f0f0f0; padding: 1px 5px; border-radius: 4px; }
</style>
</head>
<body>
  <div class="card">${bodyInner}</div>
</body>
</html>`;
}

export function renderOAuthSuccess(token: { expiresAt: number; scope?: string }): string {
  const expires = new Date(token.expiresAt).toISOString();
  return page(
    "Etsy verbunden",
    `<h1 class="ok">✓ Etsy-Shop verbunden</h1>
     <p>Der OAuth-Grant war erfolgreich. Der (rotierende) Refresh-Token liegt jetzt im KV; der
        Gatekeeper kann ab sofort im Namen der Shop-Inhaberin lesen und – nach Freigabe – schreiben.</p>
     <p class="muted">Access-Token laeuft ab: <code>${esc(expires)}</code>${
       token.scope ? ` · Scopes: <code>${esc(token.scope)}</code>` : ""
     }</p>
     <p class="muted">Dieses Fenster kann geschlossen werden. Status jederzeit unter
        <code>GET /api/token/status</code>.</p>`,
  );
}

function successResult(token: { expiresAt: number; scope?: string }): CallbackResult {
  return { status: 200, html: renderOAuthSuccess(token) };
}

export function renderOAuthError(title: string, detail: string): string {
  return page(
    "Fehler",
    `<h1 class="err">✗ ${esc(title)}</h1>
     <p>${esc(detail)}</p>`,
  );
}

function errorResult(status: number, title: string, detail: string): CallbackResult {
  return { status, html: renderOAuthError(title, detail) };
}
