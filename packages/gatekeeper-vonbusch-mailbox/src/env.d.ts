// Projekt-spezifisches ctx.exports-Typing (gleiche Form wie gatekeeper-test/src/env.d.ts). Die
// ausgelieferten Gatekeeper bekommen das `exports`-Member aus ihrer generierten
// worker-configuration.d.ts; dieses Paket zeigt `main` direkt auf die Quelle und deklariert es hier.
// Muss ein globales Script bleiben (kein Top-Level import/export), damit die Merges greifen.

declare namespace Cloudflare {
  interface GlobalProps {
    // Speist Cloudflare.Exports (Typ von ctx.exports).
    mainModule: typeof import("./mailbox-gatekeeper.js");
    // DO-Klassen, die als DO-Namespaces auf ctx.exports erscheinen.
    durableNamespaces: "MailboxGatekeeper";
  }
  // Optionales Upstream-Secret (kein Var ⇒ nicht in der generierten worker-configuration.d.ts).
  interface Env {
    MAILBOX_UPSTREAM_TOKEN?: string;
  }
}

interface ExecutionContext<Props = unknown> {
  readonly exports: Cloudflare.Exports;
}

interface DurableObjectState<Props = unknown> {
  readonly exports: Cloudflare.Exports;
}
