import { Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type {
  RoboMonInstanceConfiguratorRpc,
  RoboMonInstanceConfiguratorValues,
} from "./instance-configurator-types";

// The whole-fleet resource has no user-selectable inputs — once the fleet is connected the resource
// URL is fully determined. The configurator just displays a confirmation of what is being connected
// and signals readiness.

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
        label="Whole-fleet access (read-only)"
        description="This binding grants read-only access to the whole von Busch RoboMon fleet: robot status, the alert center, tickets, maintenance/wear, and automation rules.">
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<RoboMonInstanceConfiguratorRpc, RoboMonInstanceConfiguratorValues>;
