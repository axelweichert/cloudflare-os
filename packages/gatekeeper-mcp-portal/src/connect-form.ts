// The one page this connector serves that asks the user something: the redirect-blocked recovery
// form. Unlike the plain MCP connector there is no "which server" prompt — the portal endpoint is a
// deployment setting — so this is the only interactive page and it appears only when the configured
// portal refuses to register our redirect URI via Dynamic Client Registration.

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

/**
 * Shown when the configured portal rejected our automatic client registration because it will not
 * allow our redirect URI. Gives the two ways forward: add our redirect URI to the portal's allowlist
 * and retry, or paste an OAuth client registered there so we skip registration entirely.
 *
 * `redirectUri` is derived from the live runtime (`baseUrl()/oauth`) by the caller, never hardcoded,
 * so it always shows the deployment's real redirect (see OWL-1600/1614/1615). There is no server-URL
 * field here — the portal endpoint is fixed by configuration — so the retry POST carries only the
 * pasted credentials.
 */
export function redirectBlockedHtml(path: string, redirectUri: string, error?: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect the MCP server portal</title><style>${PAGE_STYLE}${FORM_STYLE}</style></head>
<body><main>
  <h1>This portal won't allow our redirect URL</h1>
  <p class="sub">The MCP server portal refused to register Cloudflare&nbsp;OS automatically because it
  does not allow our redirect URL. Add this URL to the portal's list of allowed redirect URIs, then
  connect again:</p>
  <code class="code">${escapeHtml(redirectUri)}</code>
  <p class="sub">If you cannot edit the portal's allowed redirect URIs, register an OAuth client there
  yourself and paste its credentials below. We will use them directly and skip automatic
  registration.</p>
  ${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
  <form method="POST" action="${escapeHtml(path)}">
    <label for="client_id">Client ID</label>
    <input id="client_id" type="text" name="client_id"
           placeholder="the client_id you registered" required autofocus>
    <label for="client_secret">Client secret</label>
    <input id="client_secret" type="password" name="client_secret"
           placeholder="leave blank for a public client">
    <p class="hint">Stored for this connection only and never shown again. Leave the secret blank if
    the portal issued a public (PKCE-only) client.</p>
    <button type="submit">Connect with these credentials</button>
  </form>
</main></body></html>`;
}
