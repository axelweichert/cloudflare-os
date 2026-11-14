// An HA instance behind Cloudflare Access needs the deployment's service token on every request:
// the REST calls (including the connect-time ping) and the WebSocket upgrade. The token goes only to
// hosts listed exactly in CF_ACCESS_HOSTS; otherwise nothing about the requests changes.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cfAccessHeaders,
  HomeAssistantRest,
  HomeAssistantWebSocket,
  withAccessHeaders,
  type HomeAssistantCredentials,
} from "../src/homeassistant-api";

const SECRETS = { CF_ACCESS_CLIENT_ID: "client-id.access", CF_ACCESS_CLIENT_SECRET: "client-secret" };
const ACCESS_ENV = { ...SECRETS, CF_ACCESS_HOSTS: "other.example.org, HA.example.com" };
const BASE: HomeAssistantCredentials = { baseUrl: "https://ha.example.com", token: "llat" };

/** A WebSocket that runs HA's auth handshake as soon as a listener is attached. */
class FakeHomeAssistantSocket extends EventTarget {
  accepted = false;
  accept() { this.accepted = true; }
  close() { this.dispatchEvent(new Event("close")); }
  send(data: string) {
    if (JSON.parse(data).type === "auth") {
      queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "auth_ok" }) })));
    }
  }
  override addEventListener(...args: Parameters<EventTarget["addEventListener"]>) {
    super.addEventListener(...args);
    if (args[0] === "message" && !this.#greeted) {
      this.#greeted = true;
      queueMicrotask(() => this.dispatchEvent(
        new MessageEvent("message", { data: JSON.stringify({ type: "auth_required" }) })));
    }
  }
  #greeted = false;
}

function stubRestFetch() {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) =>
    new Response(JSON.stringify({ message: "API running." }), { headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cfAccessHeaders", () => {
  it("returns both headers for a listed host, matched case-insensitively", () => {
    expect(cfAccessHeaders(ACCESS_ENV, "https://ha.example.com")).toEqual({
      "CF-Access-Client-Id": "client-id.access",
      "CF-Access-Client-Secret": "client-secret",
    });
  });

  it("returns nothing when neither secret is set, leaving the credentials untouched", () => {
    expect(cfAccessHeaders({}, "https://ha.example.com")).toBeUndefined();
    expect(withAccessHeaders(BASE, {})).toBe(BASE);
  });

  it("sends nothing to a host that is not listed exactly, including lookalikes", () => {
    const env = { ...SECRETS, CF_ACCESS_HOSTS: "homeassistant.weichert.at" };
    expect(cfAccessHeaders(env, "https://homeassistant.weichert.at")).toBeDefined();
    expect(cfAccessHeaders(env, "https://HomeAssistant.Weichert.at:8443")).toBeDefined();
    for (const baseUrl of [
      "https://homeassistant.weichert.at.evil.com",
      "https://evil-homeassistant.weichert.at",
      "https://x.homeassistant.weichert.at",
      "https://weichert.at",
      "https://homeassistant.weichert.at@evil.com",
      "https://ha.example.com",
      "not a url",
    ]) {
      expect(cfAccessHeaders(env, baseUrl), baseUrl).toBeUndefined();
    }
  });

  it("sends nothing when CF_ACCESS_HOSTS is unset or empty, even with both secrets set", () => {
    for (const env of [SECRETS, { ...SECRETS, CF_ACCESS_HOSTS: "" }, { ...SECRETS, CF_ACCESS_HOSTS: " , " }]) {
      expect(cfAccessHeaders(env, "https://ha.example.com")).toBeUndefined();
      expect(withAccessHeaders(BASE, env)).toBe(BASE);
    }
  });

  it("refuses half a service token, naming the variables but not the value", () => {
    for (const env of [{ CF_ACCESS_CLIENT_ID: "client-id.access" }, { CF_ACCESS_CLIENT_SECRET: "client-secret" }]) {
      expect(() => cfAccessHeaders(env, BASE.baseUrl)).toThrow("CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET must be set together");
      try { cfAccessHeaders(env, BASE.baseUrl); } catch (e: any) {
        expect(e.message).not.toContain("client-secret");
        expect(e.message).not.toContain("client-id.access");
      }
    }
  });
});

describe("REST requests", () => {
  it("carry the Access headers alongside the bearer token when configured", async () => {
    const fetch = stubRestFetch();
    await new HomeAssistantRest(withAccessHeaders(BASE, ACCESS_ENV)).ping();
    const [url, init] = fetch.mock.calls[0]!;
    const headers = new Headers(init.headers);
    expect(url).toBe("https://ha.example.com/api/");
    expect(headers.get("CF-Access-Client-Id")).toBe("client-id.access");
    expect(headers.get("CF-Access-Client-Secret")).toBe("client-secret");
    expect(headers.get("Authorization")).toBe("Bearer llat");
    // An empty User-Agent is blocked by zone WAF rules before Access sees the request.
    expect(headers.get("User-Agent")).toBeTruthy();
  });

  it("carry no Access headers when unconfigured", async () => {
    const fetch = stubRestFetch();
    await new HomeAssistantRest(withAccessHeaders(BASE, {})).ping();
    const headers = new Headers(fetch.mock.calls[0]![1].headers);
    expect(headers.has("CF-Access-Client-Id")).toBe(false);
    expect(headers.has("CF-Access-Client-Secret")).toBe(false);
    expect([...headers.keys()]).toEqual(["authorization", "user-agent"]);
  });

  it("carry no Access headers to an unlisted host", async () => {
    const fetch = stubRestFetch();
    const creds = { baseUrl: "https://ha.example.com.evil.com", token: "llat" };
    await new HomeAssistantRest(withAccessHeaders(creds, ACCESS_ENV)).ping();
    const headers = new Headers(fetch.mock.calls[0]![1].headers);
    expect(headers.has("CF-Access-Client-Id")).toBe(false);
    expect(headers.has("CF-Access-Client-Secret")).toBe(false);
  });

  it("scrub an echoed Access secret from error text", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("proxy saw client-secret", { status: 502 })));
    await expect(new HomeAssistantRest(withAccessHeaders(BASE, ACCESS_ENV)).ping())
      .rejects.toThrow("Home Assistant returned HTTP 502: proxy saw [redacted]");
  });
});

describe("WebSocket upgrade", () => {
  it("goes through fetch with the Access headers when configured", async () => {
    const socket = new FakeHomeAssistantSocket();
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => ({ status: 101, webSocket: socket }));
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("WebSocket", vi.fn());

    const ws = await HomeAssistantWebSocket.connect(withAccessHeaders(BASE, ACCESS_ENV));

    const [url, init] = fetch.mock.calls[0]!;
    const headers = new Headers(init.headers);
    expect(url).toBe("https://ha.example.com/api/websocket");
    expect(headers.get("Upgrade")).toBe("websocket");
    expect(headers.get("CF-Access-Client-Id")).toBe("client-id.access");
    expect(headers.get("CF-Access-Client-Secret")).toBe("client-secret");
    expect(socket.accepted).toBe(true);
    expect(WebSocket).not.toHaveBeenCalled();
    await ws.close();
  });

  it("reports a refused upgrade by status only", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("denied", { status: 403 })));
    const error = await HomeAssistantWebSocket.connect(withAccessHeaders(BASE, ACCESS_ENV)).catch(e => e);
    expect(error.message).toContain("HTTP 403");
    expect(error.message).not.toContain("client-secret");
  });

  it("uses a plain WebSocket, with no fetch, for an unlisted host", async () => {
    const socket = new FakeHomeAssistantSocket();
    const WebSocketCtor = vi.fn(function () { return socket; });
    const fetch = vi.fn();
    vi.stubGlobal("WebSocket", WebSocketCtor);
    vi.stubGlobal("fetch", fetch);

    const creds = { baseUrl: "https://ha.example.com.evil.com", token: "llat" };
    const ws = await HomeAssistantWebSocket.connect(withAccessHeaders(creds, ACCESS_ENV));

    expect(WebSocketCtor).toHaveBeenCalledWith("wss://ha.example.com.evil.com/api/websocket");
    expect(fetch).not.toHaveBeenCalled();
    await ws.close();
  });

  it("uses a plain WebSocket, with no fetch, when unconfigured", async () => {
    const socket = new FakeHomeAssistantSocket();
    const WebSocketCtor = vi.fn(function () { return socket; });
    const fetch = vi.fn();
    vi.stubGlobal("WebSocket", WebSocketCtor);
    vi.stubGlobal("fetch", fetch);

    const ws = await HomeAssistantWebSocket.connect(withAccessHeaders(BASE, {}));

    expect(WebSocketCtor).toHaveBeenCalledWith("wss://ha.example.com/api/websocket");
    expect(fetch).not.toHaveBeenCalled();
    await ws.close();
  });
});
