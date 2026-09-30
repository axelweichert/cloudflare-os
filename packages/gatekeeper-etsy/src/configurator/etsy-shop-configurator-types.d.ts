export type ConfiguratorOption = {
  value: string;
  title: string;
  subtitle?: string;
  meta?: string;
};

export type EtsyShopConfiguratorValues = {
  shopName?: string | null;
};

export interface EtsyShopConfiguratorRpc {
  listShops(query: string): Promise<ConfiguratorOption[]>;
}
