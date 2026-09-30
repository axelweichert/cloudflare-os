import { Autocomplete, Field, h, Section, type ConfiguratorUISpec } from "@gadgets/configurator-ui";
import type { EtsyListingConfiguratorRpc, EtsyListingConfiguratorValues } from "./etsy-listing-configurator-types";

export default {
  initial: {},

  isReady({ values }) {
    return typeof values.listingId === "string" && values.listingId.length > 0;
  },

  initialValuesFromResourceUrl({ resourceUrl }) {
    const segments = new URL(resourceUrl).pathname.split("/").filter(Boolean);
    const idx = segments.indexOf("listing");
    const listingId = idx >= 0 ? segments[idx + 1] : undefined;
    return listingId && /^\d+$/.test(listingId) ? { listingId } : {};
  },

  resourceUrl({ values }) {
    return `https://www.etsy.com/listing/${values.listingId}`;
  },

  render({ values, setValues, ui }) {
    return <Section>
      <Field label="Listing" description="Search your shop's listings, or paste an Etsy listing URL.">
        <Autocomplete
          name="listingId"
          value={values.listingId}
          placeholder="Search or paste a listing URL..."
          loadOptions={query => ui.listListings(query)}
          onChange={listingId => setValues({ listingId })}
        />
      </Field>
    </Section>;
  },
} satisfies ConfiguratorUISpec<EtsyListingConfiguratorRpc, EtsyListingConfiguratorValues>;
