import { h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  MailArchiverWorkspaceConfiguratorRpc,
  MailArchiverWorkspaceConfiguratorValues,
} from "./mailarchiver-configurator-types";

// MailArchiver has no user inputs: the token is whole-archive and the resource URL is the fixed
// instance base URL. So the configurator is always ready and just fetches that URL from the
// gatekeeper `ui`. The real work this file does versus an inline HTML string is to exist as a proper
// configurator module — it links the MessagePort RPC runtime so the connect iframe reports ready.
export default {
  initial: {},

  isReady() {
    return true;
  },

  resourceUrl({ ui }) {
    return ui.resourceUrl();
  },

  render() {
    return <Section>Connected MailArchiver — read-only access to this archive.</Section>;
  },
} satisfies ConfiguratorUISpec<
  MailArchiverWorkspaceConfiguratorRpc,
  MailArchiverWorkspaceConfiguratorValues
>;
