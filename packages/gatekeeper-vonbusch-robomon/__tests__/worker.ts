// Test-Entry für den vitest-pool-workers-Lauf (workerd). Re-exportiert die Gadget-Klassen (damit
// der ctx.exports-Analyzer die Facets/Entrypoints sieht) und stellt einen `TestControl`-
// WorkerEntrypoint bereit, der den kompletten Gatekeeper-Fluss serverseitig über ctx.exports
// fährt — dort ist ctx.exports verfügbar und die RPC-Grenzen verhalten sich wie in Produktion.

import { WorkerEntrypoint } from "cloudflare:workers";
import { RpcTarget } from "capnweb";
import type { ObservationDescription } from "@gadgets/workshop-shared/gatekeeper";

export { default } from "../src/index.js";
export {
  GatekeeperVendor,
  RobomonAccount,
  RobomonVerifier,
  RobomonGatekeeper,
  RobomonHealthSession,
} from "../src/gadget.js";

// In-Memory-ApprovalQueue als Overseer-Double: zeichnet jede Observation auf und kann sie ablehnen.
class TestApprovalQueue extends RpcTarget {
  titles: string[] = [];
  constructor(private allow: boolean) {
    super();
  }
  async authorizeObservation(description: ObservationDescription): Promise<void> {
    this.titles.push(description.title);
    if (!this.allow) throw new Error("authorization rejected");
  }
  async submitAction(): Promise<void> {
    throw new Error("Robomon submits no actions.");
  }
}

export type FlowResult = {
  vendor: { displayName: string; autoProvisionsAccount?: boolean; providesAuth?: boolean };
  supportedResourcesEmpty: boolean;
  typesHasRobomonHealth: boolean;
  account: { singletonTsType?: string };
  resource: { url: string; tsType: string; suggestedBindingName: string };
  autoApprovable: unknown[];
  observed: { kind: string; level: string; failRatePct: number | null; alarmKind: string };
  observationTitles: string[];
  rejectedTitles: string[];
  rejectBlocked: boolean;
};

export class TestControl extends WorkerEntrypoint<Cloudflare.Env> {
  /** Fährt den kompletten read-only Gatekeeper-Fluss und liefert serialisierbare Belege. */
  async run(): Promise<FlowResult> {
    const exports = this.ctx.exports;

    // 1) Vendor beschreiben + Account provisionieren (autoProvisionsAccount, kein OAuth).
    const vendor = exports.GatekeeperVendor({});
    const vendorDesc = await vendor.describe();
    const supported = await vendor.getSupportedResources();
    const types = await vendor.getTypeScriptTypes();
    const account = await vendor.createAccount();
    const accountDesc = await account.describe();

    // 2) Singleton-DO-Class holen (validiert den Account-Fluss) und einen Stub instanziieren.
    // Der props-gebundene Class-Handle wird vom echten Overseer als Facet instanziiert; im Test
    // holen wir einen Stub über den DO-Namespace (die accountId-Props sind für die read-only
    // KV-Ableitung ohne Belang — die KV ist env-weit gebunden).
    await account.getSingletonGatekeeperClass();
    const gk = exports.RobomonGatekeeper.getByName("robomon-test");
    const resource = await gk.describe();
    const autoApprovable = await gk.getAutoApprovableActions();

    // 3) Session öffnen mit zulassendem Authorizer und alle vier Observations lesen.
    const okQueue = new TestApprovalQueue(true);
    const session = await gk.startSession(okQueue);
    const health = await session.getHealth();
    const activity = await session.getRunActivity();
    const alarm = await session.getActiveAlarm();
    await session.getTokenStatus();
    await session.getHealthLine();

    // 4) Zweite Session mit ablehnendem Authorizer → jede Read muss blockieren.
    const denyQueue = new TestApprovalQueue(false);
    const denySession = await gk.startSession(denyQueue);
    let rejectBlocked = false;
    try {
      await denySession.getHealth();
    } catch {
      rejectBlocked = true;
    }

    // addObserver lässt jeden zu (aggregierte, nicht-personenbezogene Flotten-Health).
    await gk.addObserver("observer-1", await account.getVerifier());

    return {
      vendor: {
        displayName: vendorDesc.displayName,
        autoProvisionsAccount: vendorDesc.autoProvisionsAccount,
        providesAuth: vendorDesc.providesAuth,
      },
      supportedResourcesEmpty: supported.length === 0,
      typesHasRobomonHealth: types.includes("interface RobomonHealth"),
      account: { singletonTsType: accountDesc.singleton?.tsType },
      resource: {
        url: resource.url,
        tsType: resource.tsType,
        suggestedBindingName: resource.suggestedBindingName,
      },
      autoApprovable,
      observed: {
        kind: health.kind,
        level: health.level,
        failRatePct: activity.windowFailRatePct,
        alarmKind: alarm.derivedKind,
      },
      observationTitles: okQueue.titles,
      rejectedTitles: denyQueue.titles,
      rejectBlocked,
    };
  }
}
