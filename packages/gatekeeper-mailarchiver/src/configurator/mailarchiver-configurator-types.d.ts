/** The workspace configurator has no user-selectable inputs; the token is whole-archive. */
export type MailArchiverWorkspaceConfiguratorValues = Record<string, never>;

/** `ui` capability handed to the configurator: resolves the fixed archive URL over RPC. */
export interface MailArchiverWorkspaceConfiguratorRpc {
  resourceUrl(): Promise<string>;
}
