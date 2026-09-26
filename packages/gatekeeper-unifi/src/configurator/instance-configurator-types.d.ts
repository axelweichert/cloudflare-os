export type UnifiInstanceConfiguratorValues = {
  /**
   * No user-selectable values: the configurator simply confirms the account.
   * We keep a placeholder field so that `isReady` has something to check.
   */
  confirmed?: string | null;
};

export interface UnifiInstanceConfiguratorRpc {
  /** Returns the canonical resource URL (the UniFi Site Manager console URL). */
  resourceUrl(): Promise<string>;
}
