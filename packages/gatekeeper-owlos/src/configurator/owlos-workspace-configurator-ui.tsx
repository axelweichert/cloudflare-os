import { h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  OwlosWorkspaceConfiguratorRpc,
  OwlosWorkspaceConfiguratorValues,
} from "./owlos-configurator-types";

// owlOS has no user inputs: the token is whole-workspace and the resource URL is the fixed instance
// URL. So the configurator is always ready and just fetches that URL from the gatekeeper `ui`. The
// real work this file does versus the old inline HTML string is exist as a proper configurator
// module — it links the MessagePort RPC runtime so the connect iframe reports ready.
export default {
  initial: {},

  isReady() {
    return true;
  },

  resourceUrl({ ui }) {
    return ui.resourceUrl();
  },

  render() {
    return <Section>Connected owlOS workspace — read-only access to this instance.</Section>;
  },
} satisfies ConfiguratorUISpec<OwlosWorkspaceConfiguratorRpc, OwlosWorkspaceConfiguratorValues>;
