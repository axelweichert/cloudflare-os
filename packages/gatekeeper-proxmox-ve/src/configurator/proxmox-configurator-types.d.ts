/** The host configurator has no user-selectable inputs; the token authenticates the whole host. */
export type ProxmoxConfiguratorValues = Record<string, never>;

/** `ui` capability handed to the configurator: resolves the fixed host URL over RPC. */
export interface ProxmoxConfiguratorRpc {
  resourceUrl(): Promise<string>;
}
