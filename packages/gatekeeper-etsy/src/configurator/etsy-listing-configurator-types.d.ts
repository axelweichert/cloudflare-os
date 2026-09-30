export type ConfiguratorOption = {
  value: string;
  title: string;
  subtitle?: string;
  meta?: string;
};

export type EtsyListingConfiguratorValues = {
  listingId?: string | null;
};

export interface EtsyListingConfiguratorRpc {
  listListings(query: string): Promise<ConfiguratorOption[]>;
}
