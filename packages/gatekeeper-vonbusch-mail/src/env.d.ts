// Projekt-spezifisches ctx.exports-Typing (gleiche Form wie gatekeeper-test/src/env.d.ts und
// gatekeeper-vonbusch-crm). Die ausgelieferten Gatekeeper bekommen das `exports`-Member aus ihrer
// generierten worker-configuration.d.ts; dieses Paket zeigt `main` direkt auf die Quelle und
// deklariert es hier. Muss ein globales Script bleiben (kein Top-Level import/export), damit die
// Merges greifen.

declare namespace Cloudflare {
  interface GlobalProps {
    // Speist Cloudflare.Exports (Typ von ctx.exports).
    mainModule: typeof import("./mail-gatekeeper.js");
    // DO-Klassen, die als DO-Namespaces auf ctx.exports erscheinen.
    durableNamespaces: "MailGatekeeper";
  }
}

interface ExecutionContext<Props = unknown> {
  readonly exports: Cloudflare.Exports;
}

interface DurableObjectState<Props = unknown> {
  readonly exports: Cloudflare.Exports;
}
