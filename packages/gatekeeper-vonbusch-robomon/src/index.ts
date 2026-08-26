// Robomon-Gatekeeper-Gadget (VON-1814) — Worker-Entry.
//
// Exportiert die Gatekeeper-Klassen (über RPC/DOs erreicht) und einen minimalen fetch()-Handler,
// damit das ES-Module-Worker-Format erhalten bleibt. Die Gadget-Anbindung läuft über die
// Service-Binding-RPC des `workshop-backend`, nicht über HTTP.

export {
  GatekeeperVendor,
  RobomonAccount,
  RobomonVerifier,
  RobomonGatekeeper,
  RobomonHealthSession,
} from "./gadget.js";

export default {
  async fetch(): Promise<Response> {
    return new Response("Robomon-Gatekeeper-Gadget läuft (VON-1814, read-only).", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
