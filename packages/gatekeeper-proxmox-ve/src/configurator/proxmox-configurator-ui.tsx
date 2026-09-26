import { h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  ProxmoxConfiguratorRpc,
  ProxmoxConfiguratorValues,
} from "./proxmox-configurator-types";

// Proxmox has no user inputs: the token is whole-host and the resource URL is the fixed host. So the
// configurator is always ready and just fetches that URL from the gatekeeper `ui`. Existing as a
// proper configurator module (not an inline HTML string) is what links the MessagePort RPC runtime
// so the connect iframe reports ready (owlOS-Falle OWL-1651/1654).
export default {
  initial: {},

  isReady() {
    return true;
  },

  resourceUrl({ ui }) {
    return ui.resourceUrl();
  },

  render() {
    return <Section>Connected Proxmox host — read-only API access.</Section>;
  },
} satisfies ConfiguratorUISpec<ProxmoxConfiguratorRpc, ProxmoxConfiguratorValues>;
