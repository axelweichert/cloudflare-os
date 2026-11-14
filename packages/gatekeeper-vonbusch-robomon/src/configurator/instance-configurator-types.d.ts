export type RoboMonInstanceConfiguratorValues = {
  /**
   * No user-selectable values: the configurator simply confirms the fleet connection.
   * We keep a placeholder field so that `isReady` has something to check.
   */
  confirmed?: string | null;
};

export interface RoboMonInstanceConfiguratorRpc {
  /** Returns the canonical resource URL (the RoboMon fleet dashboard URL). */
  resourceUrl(): Promise<string>;
}
