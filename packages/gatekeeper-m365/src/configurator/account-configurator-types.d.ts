export type M365AccountConfiguratorValues = {
  /**
   * No user-selectable values: connecting the account grants whole-account read access. A
   * placeholder field gives `isReady` something to check.
   */
  confirmed?: string | null;
};

export interface M365AccountConfiguratorRpc {
  /** Returns the canonical resource URL for the connected account. */
  resourceUrl(): Promise<string>;
}
