import type {
  M365EmailAddress,
  M365Event,
  M365Message,
  M365MessageSummary,
  M365Profile,
  M365Task,
  M365TaskList,
} from "./types";

// ---------------------------------------------------------------------------
// OAuth (Microsoft identity platform / Entra ID, v2.0 endpoint) + a read-only HTTP wrapper around
// Microsoft Graph v1.0.
//
// Auth is OAuth 2.0 Authorization Code flow:
//   - exchangeAuthCode() trades the redirect `code` for access + refresh tokens.
//   - refreshAccessToken() trades the refresh token for a fresh access token.
//   - Microsoft exposes no simple token-revocation endpoint for delegated tokens, so "revoke" just
//     drops the locally-stored credentials (the user removes the app under myapps/account settings).

const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const AUTHORITY_BASE_URL = "https://login.microsoftonline.com";
const REQUEST_TIMEOUT_MS = 30_000;

// Delegated read scopes. offline_access is required to receive a refresh token.
export const OAUTH_SCOPES = [
  "offline_access",
  "openid",
  "profile",
  "User.Read",
  "Mail.Read",
  "Calendars.Read",
  "Tasks.Read",
];

export function authorizeUrl(tenant: string): string {
  return `${AUTHORITY_BASE_URL}/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize`;
}

function tokenUrl(tenant: string): string {
  return `${AUTHORITY_BASE_URL}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;
}

export type M365TokenGrant = {
  accessToken: string;
  /** Present on initial exchange; on refresh Microsoft may omit it (reuse the previous one). */
  refreshToken: string | null;
  /** Seconds until the access token expires. */
  expiresIn: number;
  /** Granted scopes. */
  scopes: string[];
};

export class M365ApiError extends Error {
  status: number;
  details?: unknown;
  isAuthError: boolean;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = "M365ApiError";
    this.status = status;
    this.details = details;
    // 401 = expired/invalid token. (403 is usually a scope/consent problem, not an auth failure.)
    this.isAuthError = status === 401;
  }
}

async function parseBody(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 205) return undefined;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const text = await response.text();
    return text.length > 0 ? JSON.parse(text) : undefined;
  }
  return await response.text();
}

async function tokenRequest(
  tenant: string,
  body: URLSearchParams,
  clientId: string,
  clientSecret: string,
): Promise<M365TokenGrant> {
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);

  const response = await fetch(tokenUrl(tenant), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const parsed = await parseBody(response);
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    if (parsed && typeof parsed === "object") {
      const details = parsed as { error?: string; error_description?: string };
      message = [details.error, details.error_description].filter(Boolean).join(": ") || message;
    }
    throw new M365ApiError(response.status, message, parsed);
  }

  const result = parsed as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!result.access_token) {
    throw new M365ApiError(400, "Microsoft token exchange did not return an access token.", parsed);
  }

  return {
    accessToken: result.access_token,
    refreshToken: result.refresh_token ?? null,
    expiresIn: result.expires_in ?? 3600,
    scopes: result.scope ? result.scope.split(" ").filter(Boolean) : [],
  };
}

export async function exchangeAuthCode(
  tenant: string,
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<M365TokenGrant> {
  return await tokenRequest(
    tenant,
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      scope: OAUTH_SCOPES.join(" "),
    }),
    clientId,
    clientSecret,
  );
}

export async function refreshAccessToken(
  tenant: string,
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): Promise<M365TokenGrant> {
  return await tokenRequest(
    tenant,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: OAUTH_SCOPES.join(" "),
    }),
    clientId,
    clientSecret,
  );
}

// ---------------------------------------------------------------------------
// Raw Microsoft Graph response shapes (only the fields we consume).

export type GraphEmailAddress = { name?: string | null; address?: string | null };
export type GraphRecipient = { emailAddress?: GraphEmailAddress | null };

export type GraphUserResponse = {
  id: string;
  displayName?: string | null;
  mail?: string | null;
  userPrincipalName?: string | null;
  jobTitle?: string | null;
};

export type GraphMessageResponse = {
  id: string;
  conversationId?: string | null;
  subject?: string | null;
  bodyPreview?: string | null;
  from?: GraphRecipient | null;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  receivedDateTime?: string | null;
  isRead?: boolean;
  hasAttachments?: boolean;
  webLink?: string | null;
  body?: { contentType?: string | null; content?: string | null } | null;
};

export type GraphDateTimeZone = { dateTime?: string | null; timeZone?: string | null };

export type GraphEventResponse = {
  id: string;
  subject?: string | null;
  bodyPreview?: string | null;
  start?: GraphDateTimeZone | null;
  end?: GraphDateTimeZone | null;
  isAllDay?: boolean;
  location?: { displayName?: string | null } | null;
  organizer?: GraphRecipient | null;
  attendees?: { emailAddress?: GraphEmailAddress | null }[];
  type?: string | null;
  recurrence?: unknown;
  seriesMasterId?: string | null;
  webLink?: string | null;
};

export type GraphTaskListResponse = {
  id: string;
  displayName?: string | null;
  wellknownListName?: string | null;
};

export type GraphTaskResponse = {
  id: string;
  title?: string | null;
  status?: string | null;
  importance?: string | null;
  dueDateTime?: GraphDateTimeZone | null;
  body?: { content?: string | null } | null;
};

type GraphCollection<T> = { value?: T[] };

type RequestOptions = {
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
};

export class GraphApi {
  #getToken: () => Promise<string>;

  constructor(getToken: () => Promise<string>) {
    this.#getToken = getToken;
  }

  async #request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(GRAPH_BASE_URL + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${await this.#getToken()}`,
        Accept: "application/json",
        ...options.headers,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const parsed = await parseBody(response);
      let message = `${response.status} ${response.statusText}`;
      if (parsed && typeof parsed === "object") {
        const errorObj = (parsed as { error?: { message?: string } | string }).error;
        if (typeof errorObj === "string") message = errorObj;
        else if (errorObj?.message) message = errorObj.message;
      } else if (typeof parsed === "string" && parsed.length > 0) {
        message = parsed;
      }
      throw new M365ApiError(response.status, message, parsed);
    }

    return (await parseBody(response)) as T;
  }

  getCurrentUser(): Promise<GraphUserResponse> {
    return this.#request<GraphUserResponse>("/me", {
      query: { $select: "id,displayName,mail,userPrincipalName,jobTitle" },
    });
  }

  async listMessages(
    folder: string,
    top: number,
    search: string | undefined,
  ): Promise<GraphMessageResponse[]> {
    const select = "id,conversationId,subject,bodyPreview,from,toRecipients,receivedDateTime,isRead,hasAttachments,webLink";
    // $search and $orderby are mutually exclusive in Graph; only order when not searching.
    const query: RequestOptions["query"] = search
      ? { $top: top, $select: select, $search: `"${search.replace(/"/g, "")}"` }
      : { $top: top, $select: select, $orderby: "receivedDateTime desc" };
    const result = await this.#request<GraphCollection<GraphMessageResponse>>(
      `/me/mailFolders/${encodeURIComponent(folder)}/messages`,
      // $search requires ConsistencyLevel: eventual.
      { query, headers: search ? { ConsistencyLevel: "eventual" } : {} },
    );
    return result.value ?? [];
  }

  getMessage(id: string): Promise<GraphMessageResponse> {
    return this.#request<GraphMessageResponse>(`/me/messages/${encodeURIComponent(id)}`, {
      query: {
        $select: "id,conversationId,subject,bodyPreview,from,toRecipients,ccRecipients,receivedDateTime,isRead,hasAttachments,webLink,body",
      },
    });
  }

  async listEvents(startDateTime: string, endDateTime: string, top: number): Promise<GraphEventResponse[]> {
    // calendarView expands recurring series into instances within the window.
    const result = await this.#request<GraphCollection<GraphEventResponse>>("/me/calendarView", {
      query: {
        startDateTime,
        endDateTime,
        $top: top,
        $orderby: "start/dateTime",
        $select: "id,subject,bodyPreview,start,end,isAllDay,location,organizer,attendees,type,seriesMasterId,webLink",
      },
    });
    return result.value ?? [];
  }

  getEvent(id: string): Promise<GraphEventResponse> {
    return this.#request<GraphEventResponse>(`/me/events/${encodeURIComponent(id)}`, {
      query: {
        $select: "id,subject,bodyPreview,start,end,isAllDay,location,organizer,attendees,type,seriesMasterId,webLink",
      },
    });
  }

  async listTaskLists(): Promise<GraphTaskListResponse[]> {
    const result = await this.#request<GraphCollection<GraphTaskListResponse>>("/me/todo/lists");
    return result.value ?? [];
  }

  async listTasks(listId: string, top: number): Promise<GraphTaskResponse[]> {
    const result = await this.#request<GraphCollection<GraphTaskResponse>>(
      `/me/todo/lists/${encodeURIComponent(listId)}/tasks`,
      { query: { $top: top } },
    );
    return result.value ?? [];
  }
}

// ---------------------------------------------------------------------------
// Normalizers: raw Graph responses -> the shapes declared in types.d.ts. Pure functions, kept here
// beside the raw response types so they can be unit-tested without the Workers runtime.

function normalizeAddress(recipient: GraphRecipient | null | undefined): M365EmailAddress | null {
  const addr = recipient?.emailAddress;
  if (!addr) return null;
  return { name: addr.name ?? null, address: addr.address ?? null };
}

function normalizeAddressFrom(addr: GraphEmailAddress | null | undefined): M365EmailAddress | null {
  if (!addr) return null;
  return { name: addr.name ?? null, address: addr.address ?? null };
}

function normalizeRecipients(recipients: GraphRecipient[] | undefined): M365EmailAddress[] {
  return (recipients ?? [])
    .map(normalizeAddress)
    .filter((a): a is M365EmailAddress => a !== null);
}

export function normalizeProfile(user: GraphUserResponse): M365Profile {
  return {
    id: user.id,
    displayName: user.displayName ?? null,
    email: user.mail ?? user.userPrincipalName ?? null,
    jobTitle: user.jobTitle ?? null,
  };
}

export function normalizeMessageSummary(message: GraphMessageResponse): M365MessageSummary {
  return {
    id: message.id,
    conversationId: message.conversationId ?? null,
    subject: message.subject ?? null,
    preview: message.bodyPreview ?? "",
    from: normalizeAddress(message.from),
    toRecipients: normalizeRecipients(message.toRecipients),
    receivedDateTime: message.receivedDateTime ?? null,
    isRead: message.isRead ?? false,
    hasAttachments: message.hasAttachments ?? false,
    webLink: message.webLink ?? null,
  };
}

export function normalizeMessage(message: GraphMessageResponse): M365Message {
  const contentType = message.body?.contentType?.toLowerCase() === "html" ? "html" : "text";
  return {
    ...normalizeMessageSummary(message),
    ccRecipients: normalizeRecipients(message.ccRecipients),
    body: message.body?.content ?? "",
    bodyContentType: contentType,
  };
}

export function normalizeEvent(event: GraphEventResponse): M365Event {
  return {
    id: event.id,
    subject: event.subject ?? null,
    start: event.start?.dateTime ?? null,
    end: event.end?.dateTime ?? null,
    timeZone: event.start?.timeZone ?? event.end?.timeZone ?? null,
    isAllDay: event.isAllDay ?? false,
    location: event.location?.displayName ?? null,
    organizer: normalizeAddress(event.organizer),
    attendees: (event.attendees ?? [])
      .map(a => normalizeAddressFrom(a.emailAddress))
      .filter((a): a is M365EmailAddress => a !== null),
    preview: event.bodyPreview ?? "",
    isRecurring: event.type === "occurrence" || event.type === "seriesMaster" ||
      event.type === "exception" || event.seriesMasterId != null || event.recurrence != null,
    webLink: event.webLink ?? null,
  };
}

export function normalizeTaskList(list: GraphTaskListResponse): M365TaskList {
  return {
    id: list.id,
    displayName: list.displayName ?? "",
    isDefault: list.wellknownListName === "defaultList",
  };
}

export function normalizeTask(task: GraphTaskResponse): M365Task {
  const status = task.status ?? "notStarted";
  return {
    id: task.id,
    title: task.title ?? "",
    status,
    importance: task.importance ?? "normal",
    dueDateTime: task.dueDateTime?.dateTime ?? null,
    preview: (task.body?.content ?? "").slice(0, 280),
    isCompleted: status === "completed",
  };
}

export function accountUrl(user: GraphUserResponse): string {
  const upn = user.userPrincipalName ?? user.mail ?? user.id;
  return `https://outlook.office.com/mail/${encodeURIComponent(upn)}`;
}
