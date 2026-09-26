import { Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  UnifiInstanceConfiguratorRpc,
  UnifiInstanceConfiguratorValues,
} from "./instance-configurator-types";

// The whole-account resource has no user-selectable inputs — once the user has connected an
// account, the resource URL is fully determined. The configurator just displays a confirmation of
// what is being connected and signals readiness.

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
        description="This binding grants read-only access to every UniFi console, site, and adopted device on the connected Site Manager account.">
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<UnifiInstanceConfiguratorRpc, UnifiInstanceConfiguratorValues>;
