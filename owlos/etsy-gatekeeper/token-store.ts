// owlOS — Etsy-Gatekeeper: OAuth-2.0-Token-Lifecycle (OWL-1740)
//
// Etsy-Access-Tokens leben ~1h, Refresh-Tokens ~90 Tage; der Refresh-Token ROTIERT bei
// jedem Refresh (Etsy liefert einen neuen mit) — der neue MUSS persistiert werden, sonst
// ist der naechste Refresh tot. Das ist laut Betrieb der haeufigste Ausfallgrund, deshalb
// liegt die Logik hier zentral, speicher-agnostisch und voll testbar (Fake-fetch/Fake-clock).
//
// Ablauf:
//   getAccessToken()
//     ├─ kein Token im Store, aber `seedRefreshToken` konfiguriert → Bootstrap-Refresh
//     ├─ Token vorhanden und (expiresAt - skew) > now → direkt zurueckgeben
//     └─ sonst → refresh() gegen https://api.etsy.com/v3/public/oauth/token
//                (grant_type=refresh_token, client_id=<keystring>, refresh_token=<gespeichert>)
//                → access_token + ROTIERTEN refresh_token persistieren.
//
// Endpoint-Host-Hinweis: Der Token-Endpoint liegt auf `api.etsy.com`, NICHT auf der
// Daten-Base `openapi.etsy.com`. Beide sind getrennt konfigurierbar.

export interface StoredToken {
  accessToken: string;
  refreshToken: string;
  /** Ablaufzeitpunkt des Access-Tokens in epoch-ms. */
  expiresAt: number;
  scope?: string;
}

/** Minimaler async Token-Store — in Tests In-Memory, in Prod KV (ein Schluessel). */
export interface TokenStore {
  get(): Promise<StoredToken | undefined>;
  put(token: StoredToken): Promise<void>;
}

export interface TokenManagerConfig {
  /** Voll qualifizierter Token-Endpoint, i.d.R. https://api.etsy.com/v3/public/oauth/token */
  tokenEndpoint: string;
  /** Etsy App API-Key (keystring) — dient hier als OAuth client_id. */
  clientId: string;
  /**
   * Optionaler Bootstrap-Refresh-Token (aus `wrangler secret`). Wird nur benutzt, wenn der
   * Store leer ist — danach lebt der (rotierende) Refresh-Token im Store weiter.
   */
  seedRefreshToken?: string;
  /** Sicherheitsabstand vor Ablauf, in ms (Default 60s) — refresht leicht vorzeitig. */
  skewMs?: number;
  fetchImpl?: typeof fetch;
  clock?: () => number;
}

export interface EtsyTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
  scope?: string;
}

const DEFAULT_SKEW_MS = 60_000;

/** Fehler bei fehlgeschlagenem Token-Refresh — klar unterscheidbar vom Rate-Limit-Fehler. */
export class TokenRefreshError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "TokenRefreshError";
  }
}

export class TokenManager {
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => number;
  private readonly skewMs: number;
  /** Single-Flight: parallele getAccessToken()-Aufrufe teilen einen laufenden Refresh. */
  private inflight: Promise<StoredToken> | null = null;

  constructor(private store: TokenStore, private config: TokenManagerConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.clock = config.clock ?? (() => Date.now());
    this.skewMs = config.skewMs ?? DEFAULT_SKEW_MS;
  }

  /** Liefert einen gueltigen Access-Token; refresht bei Bedarf und persistiert die Rotation. */
  async getAccessToken(): Promise<string> {
    const current = await this.store.get();
    if (current && current.expiresAt - this.skewMs > this.clock()) {
      return current.accessToken;
    }
    const refreshToken = current?.refreshToken ?? this.config.seedRefreshToken;
    if (!refreshToken) {
      throw new TokenRefreshError(
        "Kein Refresh-Token vorhanden. Beim Wiring einen initialen Refresh-Token setzen " +
          "(Secret ETSY_SEED_REFRESH_TOKEN oder POST /api/token/seed hinter CF Access).",
      );
    }
    const token = await this.refresh(refreshToken);
    return token.accessToken;
  }

  /** Erzwingt einen Refresh mit dem gegebenen Refresh-Token; persistiert das Ergebnis. */
  async refresh(refreshToken: string): Promise<StoredToken> {
    // Single-Flight, damit gleichzeitige Aufrufe nicht mehrfach refreshen (und dabei den
    // rotierenden Refresh-Token gegenseitig invalidieren).
    if (this.inflight) return this.inflight;
    this.inflight = this.doRefresh(refreshToken).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doRefresh(refreshToken: string): Promise<StoredToken> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: this.config.clientId,
      refresh_token: refreshToken,
    });

    let resp: Response;
    try {
      resp = await this.fetchImpl(this.config.tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
    } catch (e) {
      throw new TokenRefreshError(`Token-Refresh-Netzwerkfehler: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new TokenRefreshError(
        `Token-Refresh fehlgeschlagen (HTTP ${resp.status})${text ? `: ${text.slice(0, 300)}` : ""}`,
        resp.status,
      );
    }

    let data: EtsyTokenResponse;
    try {
      data = (await resp.json()) as EtsyTokenResponse;
    } catch {
      throw new TokenRefreshError("Token-Refresh: Antwort war kein gueltiges JSON.");
    }
    if (!data.access_token || !data.refresh_token || typeof data.expires_in !== "number") {
      throw new TokenRefreshError("Token-Refresh: unvollstaendige Antwort (access_token/refresh_token/expires_in).");
    }

    const stored: StoredToken = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token, // ROTIERT — neuen Wert persistieren!
      expiresAt: this.clock() + data.expires_in * 1000,
      scope: data.scope,
    };
    await this.store.put(stored);
    return stored;
  }
}

// ---------------------------------------------------------------------------
// In-Memory-Store — deterministisch, fuer Tests & lokale Nutzung.
export class MemoryTokenStore implements TokenStore {
  private token: StoredToken | undefined;
  constructor(seed?: StoredToken) {
    this.token = seed;
  }
  async get(): Promise<StoredToken | undefined> {
    return this.token;
  }
  async put(token: StoredToken): Promise<void> {
    this.token = token;
  }
}

// ---------------------------------------------------------------------------
// KV-Store — ein einzelner Schluessel haelt den (rotierenden) Token-Satz.
// Minimales KV-Interface (workerd) — kein cloudflare:workers-Import noetig.
export interface KvLike {
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string): Promise<void>;
}

export class KvTokenStore implements TokenStore {
  constructor(private kv: KvLike, private key = "etsy:oauth-token") {}
  async get(): Promise<StoredToken | undefined> {
    const raw = (await this.kv.get(this.key, "json")) as StoredToken | null;
    return raw ?? undefined;
  }
  async put(token: StoredToken): Promise<void> {
    await this.kv.put(this.key, JSON.stringify(token));
  }
}
