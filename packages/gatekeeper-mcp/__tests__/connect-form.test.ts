import { describe, expect, it } from "vitest";

import { connectFormHtml, redirectBlockedHtml } from "../src/connect-form.js";

describe("redirectBlockedHtml", () => {
  const html = redirectBlockedHtml(
    "/gatekeeper/mcp/DOID/NONCE",
    "https://cloudflareos.weichert.at/gatekeeper/mcp/oauth",
    "https://allowlist.example/mcp",
  );

  it("shows the live redirect URI so the user can allowlist it", () => {
    expect(html).toContain("https://cloudflareos.weichert.at/gatekeeper/mcp/oauth");
    expect(html).not.toContain("localhost");
  });

  it("offers a manual client form that POSTs back to the connect path", () => {
    expect(html).toContain('action="/gatekeeper/mcp/DOID/NONCE"');
    expect(html).toContain('name="client_id"');
    expect(html).toContain('name="client_secret"');
    // The secret input must be masked.
    expect(html).toMatch(/name="client_secret"[^>]*type="password"|type="password"[^>]*name="client_secret"/);
  });

  it("prefills the known server URL", () => {
    expect(html).toContain('value="https://allowlist.example/mcp"');
  });

  it("escapes an error message rather than rendering a raw blob", () => {
    const withErr = redirectBlockedHtml("/p", "https://x/oauth", "https://s/mcp", "<script>x</script>");
    expect(withErr).toContain("&lt;script&gt;");
    expect(withErr).not.toContain("<script>x");
  });
});

describe("connectFormHtml", () => {
  it("still renders the plain endpoint prompt", () => {
    const html = connectFormHtml("/p");
    expect(html).toContain('name="url"');
    expect(html).toContain("Connect an MCP server");
  });
});
