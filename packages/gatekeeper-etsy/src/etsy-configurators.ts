// Resource-configurator capabilities exposed to the sandboxed picker iframes (OWL-1748).
//
// One class per grantable resource type: a whole shop, or a single listing. Both are narrow,
// read-only helpers — they search Etsy on the user's behalf so the iframe can present options.

import { RpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { EtsyApi } from "./etsy-api";
import type { EtsyShopConfiguratorRpc } from "./configurator/etsy-shop-configurator-types";
import type { EtsyListingConfiguratorRpc } from "./configurator/etsy-listing-configurator-types";

type ConfiguratorOption = { value: string; title: string; subtitle?: string; meta?: string };

const OPTION_LIMIT = 100;

const apiGetters = new WeakMap<object, () => EtsyApi>();
const shopNames = new WeakMap<object, string>();

function apiFor(target: object): EtsyApi {
  const getApi = apiGetters.get(target);
  if (!getApi) throw new Error("Etsy configurator is not initialized.");
  return getApi();
}

function shopNameFor(target: object): string {
  return shopNames.get(target) ?? "";
}

/** Parses a listing id out of a raw id or an Etsy listing URL. */
function parseListingId(input: string): string | null {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.hostname !== "www.etsy.com" && url.hostname !== "etsy.com") return null;
    const segments = url.pathname.split("/").filter(Boolean);
    const idx = segments.indexOf("listing");
    const candidate = idx >= 0 ? segments[idx + 1] : undefined;
    return candidate && /^\d+$/.test(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

@validateRpc()
export class EtsyShopConfiguratorUI extends RpcTarget implements EtsyShopConfiguratorRpc {
  constructor(getApi: () => EtsyApi, shopName: string) {
    super();
    apiGetters.set(this, getApi);
    shopNames.set(this, shopName);
  }

  /** This gatekeeper is scoped to a single shop, so the picker offers exactly that shop. */
  async listShops(_query: string): Promise<ConfiguratorOption[]> {
    const shopName = shopNameFor(this);
    try {
      const shopId = await apiFor(this).resolveShopId(shopName);
      const shop = await apiFor(this).getShop(shopId);
      return [
        {
          value: shop.shopName,
          title: shop.title ?? shop.shopName,
          subtitle: shop.shopName,
          meta: `${shop.activeListingCount} active`,
        },
      ];
    } catch {
      return [{ value: shopName, title: shopName, subtitle: shopName }];
    }
  }
}

@validateRpc()
export class EtsyListingConfiguratorUI extends RpcTarget implements EtsyListingConfiguratorRpc {
  constructor(getApi: () => EtsyApi, shopName: string) {
    super();
    apiGetters.set(this, getApi);
    shopNames.set(this, shopName);
  }

  async listListings(query: string): Promise<ConfiguratorOption[]> {
    const api = apiFor(this);
    const shopId = await api.resolveShopId(shopNameFor(this));

    // Direct id / URL entry: resolve it precisely and surface it first.
    const directId = parseListingId(query);
    if (directId) {
      try {
        const listing = await api.getListing(directId);
        return [listingOption(listing)];
      } catch {
        // fall through to a search over the shop's listings
      }
    }

    const listings = await api.listListings(shopId, { limit: OPTION_LIMIT });
    const term = query.trim().toLowerCase();
    return listings
      .filter(listing => !term || `${listing.listingId} ${listing.title}`.toLowerCase().includes(term))
      .slice(0, OPTION_LIMIT)
      .map(listingOption);
  }
}

function listingOption(listing: { listingId: string; title: string; state: string }): ConfiguratorOption {
  return {
    value: listing.listingId,
    title: listing.title,
    subtitle: `#${listing.listingId}`,
    meta: listing.state,
  };
}
