// Preiserhebungs-Gatekeeper-Gadget (VON-1816) — Worker-Entry.
//
// Exportiert die Gatekeeper-Klassen (über RPC/DOs erreicht) und einen minimalen fetch()-Handler,
// damit das ES-Module-Worker-Format erhalten bleibt. Die Gadget-Anbindung läuft über die
// Service-Binding-RPC des `workshop-backend`, nicht über HTTP.

export {
  GatekeeperVendor,
  PreiserhebungAccount,
  PreiserhebungVerifier,
  PreiserhebungGatekeeper,
  PreiserhebungReadSession,
} from "./gadget";

export default {
  async fetch(): Promise<Response> {
    return new Response("Preiserhebungs-Gatekeeper-Gadget läuft (VON-1816, read-only).", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
