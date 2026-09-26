// Product-independent token helpers, split out so they unit-test under plain `node --test` without
// pulling in product.ts / the runtime (which only resolves under the bundler).

export class ProxmoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProxmoxError";
  }
}

/** Trim and shape-check a pasted token. Fails fast on obviously-wrong input without a network call. */
export function normalizeToken(raw: string): string {
  const token = raw.trim();
  if (!token) throw new ProxmoxError("An API token is required.");
  // Proxmox tokens are "USER@REALM!TOKENID=SECRET". Validate the shape enough to reject a mispaste
  // before we ever hit the origin (so a bad paste never counts as a live auth attempt).
  if (!/^[^@\s]+@[^!\s]+![^=\s]+=\S+$/.test(token)) {
    throw new ProxmoxError(
      'That does not look like a Proxmox API token. Expected the form "USER@REALM!TOKENID=SECRET".',
    );
  }
  return token;
}
