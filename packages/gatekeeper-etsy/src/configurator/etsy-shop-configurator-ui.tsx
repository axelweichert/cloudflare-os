import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { EtsyShopConfiguratorRpc, EtsyShopConfiguratorValues } from "./etsy-shop-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.shopName === "string" && values.shopName.length > 0;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const segments = new URL(resourceUrl).pathname.split("/").filter(Boolean);
    const idx = segments.indexOf("shop");
    const shopName = idx >= 0 ? segments[idx + 1] : undefined;
    return shopName ? { shopName } : {};
  },

  resourceUrl({ values }) {
    return `https://www.etsy.com/shop/${values.shopName}`;
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label="Shop" description="Select the Etsy shop to connect.">
        <Autocomplete
          name="shopName"
          value={values.shopName}
          placeholder="Select a shop..."
          loadOptions={query => ui.listShops(query)}
          onChange={shopName => setValues({ shopName })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<EtsyShopConfiguratorRpc, EtsyShopConfiguratorValues>;
