// Product-independent token helpers, split out so they unit-test under plain `node --test` without
// pulling in product.ts / the runtime (which only resolves under the bundler).

export class ProxmoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProxmoxError";
  }
}

/** Optional Cloudflare Access service token, sent as CF-Access-Client-Id / CF-Access-Client-Secret. */
export interface CfAccessCredentials {
  clientId: string;
  clientSecret: string;
}

/** Trim and shape-check a pasted token. Fails fast on obviously-wrong input without a network call. */
export function normalizeToken(raw: string): string {
  const token = raw.trim();
  if (!token) throw new ProxmoxError("Ein API-Token ist erforderlich.");
  // Proxmox tokens are "USER@REALM!TOKENID=SECRET". Validate the shape enough to reject a mispaste
  // before we ever hit the origin (so a bad paste never counts as a live auth attempt).
  if (!/^[^@\s]+@[^!\s]+![^=\s]+=\S+$/.test(token)) {
    throw new ProxmoxError(
      'Das sieht nicht nach einem Proxmox-API-Token aus. Erwartet wird die Form "BENUTZER@REALM!TOKEN-ID=GEHEIMNIS".',
    );
  }
  return token;
}

/**
 * Normalize the optional Cloudflare Access service token from the connect form. Both fields empty
 * means "none" (undefined); exactly one filled in, or whitespace inside a value, is rejected.
 */
export function normalizeCfAccess(id?: string, secret?: string): CfAccessCredentials | undefined {
  const clientId = (id ?? "").trim();
  const clientSecret = (secret ?? "").trim();
  if (!clientId && !clientSecret) return undefined;
  if (!clientId || !clientSecret) {
    throw new ProxmoxError(
      "Ein Cloudflare-Access-Service-Token benötigt sowohl eine Client ID als auch ein Client Secret (oder lassen Sie beide Felder leer).",
    );
  }
  if (/\s/.test(clientId) || /\s/.test(clientSecret)) {
    throw new ProxmoxError("Client ID und Client Secret des Cloudflare-Access-Tokens dürfen keine Leerzeichen enthalten.");
  }
  return { clientId, clientSecret };
}
