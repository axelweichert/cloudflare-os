/** The workspace configurator has no user-selectable inputs; the token is whole-workspace. */
export type OwlosWorkspaceConfiguratorValues = Record<string, never>;

/** `ui` capability handed to the configurator: resolves the fixed instance URL over RPC. */
export interface OwlosWorkspaceConfiguratorRpc {
  resourceUrl(): Promise<string>;
}
