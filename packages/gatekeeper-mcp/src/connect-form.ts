// The one page this gatekeeper serves that asks the user something: which MCP server to connect.
// Lives here rather than in `@gadgets/mcp-shared/html` because the gateway connector, whose endpoint
// is a deployment setting, has no equivalent page.

import { escapeHtml, PAGE_STYLE } from "@gadgets/mcp-shared/html";

// Form controls, on top of the palette and page frame every connect page shares.
const FORM_STYLE = `
  label { display: block; font-size: 14px; font-weight: 600; color: var(--strong); margin: 0 0 6px; }
  p.hint { margin: 6px 0 0; font-size: 13px; color: var(--subtle); }

  input { width: 100%; box-sizing: border-box; padding: 9px 11px; font: inherit;
          background: var(--control); color: var(--text);
          border: 1px solid var(--line); border-radius: 8px; }
  input::placeholder { color: var(--subtle); }
  input:focus { outline: 0; border-color: var(--brand);
                box-shadow: 0 0 0 3px color-mix(in srgb, var(--brand) 22%, transparent); }
  input + label { margin-top: 16px; }

  button { width: 100%; margin-top: 20px; padding: 10px; border: 0; border-radius: 8px;
           background: var(--contrast); color: var(--on-contrast); font: inherit; font-weight: 600;
           cursor: pointer; }
  button:hover { opacity: .9; }

  .code { display: block; margin: 10px 0; padding: 10px 12px; font-family: ui-monospace, monospace;
          font-size: 13px; word-break: break-all; background: var(--control);
          border: 1px solid var(--line); border-radius: 8px; color: var(--strong); }
`;

/** Renders the endpoint prompt shown when the user starts connecting. */
export function connectFormHtml(path: string, error?: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect an MCP server</title><style>${PAGE_STYLE}${FORM_STYLE}</style></head>
<body><main>
  <h1>Connect an MCP server</h1>
  <p class="sub">We will discover the server's tools and, if it requires authorization, take you
  through its sign-in.</p>
  ${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
  <form method="POST" action="${escapeHtml(path)}">
    <label for="url">Server URL</label>
    <input id="url" type="url" name="url" placeholder="https://example.com/mcp" required autofocus>
    <p class="hint">Only connect a server you trust. Its own annotations decide which of its tools
    run without asking you and which wait for your approval, and an annotation is only as
    trustworthy as the server that sent it.</p>
    <button type="submit">Continue</button>
  </form>
</main></body></html>`;
}

/**
 * Shown when the server rejected our automatic client registration because it will not allow our
 * redirect URI. Gives the user the two ways forward: add our redirect URI to the server's allowlist
 * and retry, or paste an OAuth client they registered themselves so we skip registration entirely.
 *
 * `redirectUri` is derived from the live runtime (`baseUrl()/oauth`) by the caller, never hardcoded,
 * so it always shows the deployment's real redirect (see OWL-1600/1614/1615). `serverUrl` prefills
 * the retry so the known endpoint is not retyped.
 */
export function redirectBlockedHtml(
  path: string, redirectUri: string, serverUrl: string, error?: string,
): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect an MCP server</title><style>${PAGE_STYLE}${FORM_STYLE}</style></head>
<body><main>
  <h1>This server won't allow our redirect URL</h1>
  <p class="sub">The MCP server refused to register Cloudflare&nbsp;OS automatically because it does
  not allow our redirect URL. Add this URL to the server's list of allowed redirect URIs, then
  connect again:</p>
  <code class="code">${escapeHtml(redirectUri)}</code>
  <p class="sub">If the server does not let you edit its allowed redirect URIs, register an OAuth
  client there yourself and paste its credentials below. We will use them directly and skip
  automatic registration.</p>
  ${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
  <form method="POST" action="${escapeHtml(path)}">
    <label for="url">Server URL</label>
    <input id="url" type="url" name="url" value="${escapeHtml(serverUrl)}" required>
    <label for="client_id">Client ID</label>
    <input id="client_id" type="text" name="client_id"
           placeholder="the client_id you registered" required autofocus>
    <label for="client_secret">Client secret</label>
    <input id="client_secret" type="password" name="client_secret"
           placeholder="leave blank for a public client">
    <p class="hint">Stored for this connection only and never shown again. Leave the secret blank if
    the server issued a public (PKCE-only) client.</p>
    <button type="submit">Connect with these credentials</button>
  </form>
</main></body></html>`;
}
