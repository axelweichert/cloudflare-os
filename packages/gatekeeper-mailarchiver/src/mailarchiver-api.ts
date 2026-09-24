// Thin, read-only client over an owlOS MailArchiver instance's HTTP API. The MailArchiver exposes
// its archive under `{baseUrl}/api/*`. Every `/api/*` route is guarded by the MailArchiver's own
// auth middleware (`@owlos/gatekeeper`), which accepts either a Cloudflare Access session or an
// `Authorization: Bearer owl_…` API token. API tokens are READ-ONLY: the middleware rejects any
// non-GET/HEAD request with 403, which suits this connector exactly.
//
// The MailArchiver's external API is additionally fronted by Cloudflare Access, so a real request
// from this Worker must also carry a CF Access *service token* (`CF-Access-Client-Id` /
// `CF-Access-Client-Secret`) to get past the edge before the Bearer token is even seen. Both are
// wired here; the service-token pair is optional in the credential so the connect flow can be
// completed and re-pointed without it, but production reads need it (see the connect UI hint).
//
// Response field names below are transformed from the MailArchiver's snake_case JSON into the
// camelCase shapes documented in types.d.ts, so the agent-facing API is clean.

import type {
  ArchiveStats,
  Attachment,
  AttachmentContent,
  Contact,
  Mailbox,
  MailboxTreeLevel,
  MessageBody,
  MessageMetadata,
  MessageSummary,
} from "./types";

// ponytail: local copy of workshop-shared's stripTrailingSlashes (a 3-liner). Kept local so this
// driver has zero runtime imports and stays unit-testable under plain node — importing it from
// workshop-shared/gatekeeper transitively pulls in `cloudflare:workers`, which only loads in-runtime.
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) --end;
  return end === value.length ? value : value.slice(0, end);
}

const API_TOKEN_PREFIX = "owl_";
const FETCH_TIMEOUT_MS = 20_000;

export interface MailArchiverCredentials {
  /** Instance root, e.g. "https://mailarchiver.owl-os.cloud". No trailing slash, no "/api". */
  baseUrl: string;
  /** MailArchiver API token, `owl_…`, sent as `Authorization: Bearer …`. Read-only. */
  apiToken: string;
  /** Cloudflare Access service-token client id (`CF-Access-Client-Id`). Optional. */
  serviceClientId?: string;
  /** Cloudflare Access service-token client secret (`CF-Access-Client-Secret`). Optional. */
  serviceClientSecret?: string;
}

export class MailArchiverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailArchiverError";
  }
}

/** Normalize a user-entered base URL to an https root with no trailing slash or "/api" suffix. */
export function normalizeBaseUrl(raw: string): string {
  let value = raw.trim();
  if (!value) throw new MailArchiverError("A MailArchiver base URL is required.");
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MailArchiverError(`"${raw}" is not a valid URL.`);
  }
  if (url.protocol !== "https:") {
    throw new MailArchiverError("The base URL must use https.");
  }
  let base = stripTrailingSlashes(url.origin + url.pathname);
  if (base.toLowerCase().endsWith("/api")) base = base.slice(0, -"/api".length);
  return stripTrailingSlashes(base);
}

/** Build the auth headers: Bearer API token, plus CF Access service token when configured. */
function authHeaders(creds: MailArchiverCredentials): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${creds.apiToken}`,
  };
  if (creds.serviceClientId && creds.serviceClientSecret) {
    headers["CF-Access-Client-Id"] = creds.serviceClientId;
    headers["CF-Access-Client-Secret"] = creds.serviceClientSecret;
  }
  return headers;
}

async function doFetch(url: string, headers: Record<string, string>): Promise<Response> {
  try {
    return await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (e: any) {
    throw new MailArchiverError(`Unable to reach ${url}: ${e?.message ?? e}`);
  }
}

/**
 * Confirm the token authenticates against a real MailArchiver instance, before storing anything.
 * Probes `GET {base}/api/stats` (a read-only endpoint) with the wired auth headers and requires 200.
 * Throws MailArchiverError with a user-facing message on any failure.
 *
 * Note: this is only ever invoked when a human completes the connect flow. Nothing calls it at build
 * or deploy time.
 */
export async function verifyCredentials(
  rawBaseUrl: string,
  apiToken: string,
  serviceClientId?: string,
  serviceClientSecret?: string,
): Promise<MailArchiverCredentials> {
  const baseUrl = normalizeBaseUrl(rawBaseUrl);
  const token = apiToken.trim();
  if (!token.startsWith(API_TOKEN_PREFIX)) {
    throw new MailArchiverError(
      `The API token does not look like a MailArchiver token (expected an "${API_TOKEN_PREFIX}…" value).`,
    );
  }
  const creds: MailArchiverCredentials = {
    baseUrl,
    apiToken: token,
    serviceClientId: serviceClientId?.trim() || undefined,
    serviceClientSecret: serviceClientSecret?.trim() || undefined,
  };

  const resp = await doFetch(`${baseUrl}/api/stats`, {
    Accept: "application/json",
    ...authHeaders(creds),
  });
  if (resp.status === 200) return creds;
  if (resp.status === 401 || resp.status === 403) {
    throw new MailArchiverError(
      "MailArchiver rejected the API token. Check that the token is valid (and not revoked) for " +
        "this instance and try again.",
    );
  }
  // A CF Access login page (HTML redirect) means the service token is missing or wrong.
  if (resp.status === 302 || resp.headers.get("content-type")?.includes("text/html")) {
    throw new MailArchiverError(
      `${baseUrl} is fronted by Cloudflare Access. Provide a valid CF Access service token ` +
        "(client id + secret) alongside the API token.",
    );
  }
  throw new MailArchiverError(`MailArchiver /api/stats returned HTTP ${resp.status}.`);
}

// ---------------------------------------------------------------------------
// Response mapping helpers

/** Parse a JSON-encoded address array (the API stores To/Cc as a JSON string) into a string[]. */
function parseAddressList(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((x) => String(x)) : [];
  } catch {
    return [raw];
  }
}

function mapMessageSummary(m: any): MessageSummary {
  return {
    id: String(m.id),
    mailboxId: String(m.mailbox_id),
    direction: m.direction === "outbound" ? "outbound" : "inbound",
    subject: m.subject ?? null,
    fromAddress: m.from_address ?? "",
    fromName: m.from_name ?? null,
    toAddresses: parseAddressList(m.to_addresses),
    receivedAt: m.received_at,
    hasAttachments: Boolean(m.has_attachments),
  };
}

function mapMessageMetadata(m: any): MessageMetadata {
  return {
    ...mapMessageSummary(m),
    ccAddresses: parseAddressList(m.cc_addresses),
    sizeBytes: m.size_bytes ?? null,
    internetMessageId: m.internet_message_id ?? null,
    conversationId: m.conversation_id ?? null,
    createdAt: m.created_at,
  };
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Authenticated read-only client for a connected MailArchiver instance.

export class MailArchiverClient {
  #creds: MailArchiverCredentials;

  constructor(creds: MailArchiverCredentials) {
    this.#creds = creds;
  }

  #jsonHeaders(): Record<string, string> {
    return { Accept: "application/json", ...authHeaders(this.#creds) };
  }

  async #getJson(path: string): Promise<any> {
    const resp = await doFetch(`${this.#creds.baseUrl}${path}`, this.#jsonHeaders());
    if (resp.status === 401 || resp.status === 403) {
      throw new MailArchiverError("MailArchiver credentials are no longer valid.");
    }
    if (resp.status === 404) throw new MailArchiverError("Not found.");
    if (resp.status !== 200) throw new MailArchiverError(`MailArchiver ${path} returned HTTP ${resp.status}.`);
    try {
      return await resp.json();
    } catch {
      throw new MailArchiverError(`MailArchiver ${path} did not return JSON.`);
    }
  }

  async #getRaw(path: string): Promise<Response> {
    const resp = await doFetch(`${this.#creds.baseUrl}${path}`, authHeaders(this.#creds));
    if (resp.status === 401 || resp.status === 403) {
      throw new MailArchiverError("MailArchiver credentials are no longer valid.");
    }
    if (resp.status === 404) throw new MailArchiverError("Not found.");
    if (resp.status !== 200) throw new MailArchiverError(`MailArchiver ${path} returned HTTP ${resp.status}.`);
    return resp;
  }

  async stats(): Promise<ArchiveStats> {
    const b = await this.#getJson("/api/stats");
    const kpi = b.kpi ?? {};
    return {
      totalMessages: kpi.total_messages ?? 0,
      totalAttachments: kpi.total_attachments ?? 0,
      storageBytes: kpi.storage_bytes ?? 0,
      avgPerDay: kpi.avg_per_day ?? 0,
      firstDate: kpi.first_date ?? null,
      messagesOverTime: (b.messages_over_time ?? []).map((r: any) => ({ month: r.month, count: r.count })),
      topSenders: (b.top_senders ?? []).map((r: any) => ({ address: r.address, count: r.count })),
      directionRatio: {
        inbound: b.direction_ratio?.inbound ?? 0,
        outbound: b.direction_ratio?.outbound ?? 0,
      },
      perMailbox: (b.per_mailbox ?? []).map((r: any) => ({
        mailboxId: String(r.mailbox_id),
        displayName: r.display_name ?? null,
        email: r.email,
        count: r.count,
      })),
    };
  }

  async mailboxes(): Promise<Mailbox[]> {
    const b = await this.#getJson("/api/mailboxes");
    return (b.mailboxes ?? []).map((m: any) => ({
      id: String(m.id),
      email: m.email,
      displayName: m.display_name ?? null,
      provider: m.provider === "google" ? "google" : "microsoft",
      enabled: Boolean(m.enabled),
      archivedCount: m.archived_count ?? 0,
      lastSyncAt: m.last_sync_at ?? null,
    }));
  }

  async search(query: string): Promise<MessageSummary[]> {
    const b = await this.#getJson(`/api/messages?q=${encodeURIComponent(query)}`);
    return (b.messages ?? []).map(mapMessageSummary);
  }

  async message(id: string): Promise<MessageMetadata> {
    const b = await this.#getJson(`/api/messages/${encodeURIComponent(id)}`);
    return mapMessageMetadata(b.message ?? b);
  }

  async body(id: string): Promise<MessageBody> {
    const resp = await this.#getRaw(`/api/messages/${encodeURIComponent(id)}/body`);
    return {
      contentType: resp.headers.get("content-type") ?? "text/plain; charset=utf-8",
      content: await resp.text(),
    };
  }

  async attachments(id: string): Promise<Attachment[]> {
    const b = await this.#getJson(`/api/messages/${encodeURIComponent(id)}/attachments`);
    return (b.attachments ?? []).map((a: any) => ({
      id: String(a.id),
      filename: a.filename,
      mimeType: a.mime_type ?? null,
      sizeBytes: a.size_bytes ?? null,
    }));
  }

  async attachment(id: string, attId: string): Promise<AttachmentContent> {
    const resp = await this.#getRaw(
      `/api/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attId)}`,
    );
    const bytes = new Uint8Array(await resp.arrayBuffer());
    const disposition = resp.headers.get("content-disposition") ?? "";
    const match = /filename="?([^";]+)"?/i.exec(disposition);
    return {
      filename: match?.[1] ?? attId,
      mimeType: resp.headers.get("content-type") ?? null,
      sizeBytes: bytes.byteLength,
      base64: toBase64(bytes),
    };
  }

  async eml(id: string): Promise<string> {
    const resp = await this.#getRaw(`/api/messages/${encodeURIComponent(id)}/eml`);
    return await resp.text();
  }

  async contacts(mailboxId: string): Promise<Contact[]> {
    const b = await this.#getJson(`/api/tree?mailbox=${encodeURIComponent(mailboxId)}`);
    return (b.contacts ?? []).map((c: any) => ({
      address: c.contact,
      name: c.contact_name ?? null,
      count: c.count,
    }));
  }

  /** Drill down the contact/date tree. The reached depth determines the returned shape. */
  async tree(
    mailboxId: string,
    contact: string,
    year?: string,
    month?: string,
    day?: string,
  ): Promise<MailboxTreeLevel> {
    const segments = [contact, year, month, day].filter((s): s is string => s != null && s !== "");
    const path =
      `/api/tree/${segments.map((s) => encodeURIComponent(s)).join("/")}` +
      `?mailbox=${encodeURIComponent(mailboxId)}`;
    const b = await this.#getJson(path);
    if (year == null) return { level: "years", years: b.years ?? [] };
    if (month == null) return { level: "months", months: b.months ?? [] };
    if (day == null) return { level: "days", days: b.days ?? [] };
    return { level: "messages", messages: (b.messages ?? []).map(mapMessageSummary) };
  }
}
