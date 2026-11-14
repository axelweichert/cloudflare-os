import { Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  M365AccountConfiguratorRpc,
  M365AccountConfiguratorValues,
} from "./account-configurator-types";

// The whole-account resource has no user-selectable inputs — once an account is connected, the
// resource URL is fully determined. The configurator confirms which account is being connected and
// signals readiness. The sandboxed runtime has no effect hooks, so we render static text and rely
// on `resourceUrl` (via the `ui` capability) to produce the canonical URL.

export default {
  initial: { confirmed: "yes" },

  isReady() {
    return true;
  },

  resourceUrl({ ui }) {
    return ui.resourceUrl();
  },

  render() {
    return <Section>
      <Field
        label="Whole-account access (read-only)"
        description="This binding grants read access to the connected Microsoft 365 account: Outlook mail, calendar events, and Microsoft To Do tasks.">
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<M365AccountConfiguratorRpc, M365AccountConfiguratorValues>;
