import type { EventBus } from "../../events/index.js";

/** Says which entitlements an organization has; the extension registers them, and the hub unions the answers. */
export type EntitlementSource = (orgId: string) => Promise<ReadonlySet<string>>;

/** What the hub knows of one organization's entitlements. */
export interface OrgEntitlements {
  has: (name: string) => Promise<boolean>;
  /** Every entitlement, sorted. */
  list: () => Promise<readonly string[]>;
  /** Drops the cached answer, so the next question asks the sources again: for a change of the entitlements. */
  forget: () => void;
}

/** The entitlements of an organization: docs/architecture/hub/access.md#checking-entitlements. */
export type Entitlements = (orgId: string) => OrgEntitlements;

/** What the entitlements need from the hub. */
export interface EntitlementsOptions {
  sources: readonly EntitlementSource[];
  /** The clock in milliseconds. */
  now: () => number;
}

/** An answer is kept this long, so `welcome` and every gated request need no source round trip. */
export const ENTITLEMENT_TTL_MS = 60_000;
// The oldest answer is dropped past this many organizations; a Cloud hub asks about the busy ones again and again
const MAX_CACHED_ORGS = 10_000;

interface Cached {
  expiresAt: number;
  names: Promise<ReadonlySet<string>>;
}

const askSources = async (sources: readonly EntitlementSource[], orgId: string): Promise<ReadonlySet<string>> => {
  const answers = await Promise.all(sources.map(async (source) => await source(orgId)));
  return new Set(answers.flatMap((answer) => [...answer]));
};

/**
 * Builds `entitlements(orgId)`: the union of what the sources say, cached for 60 s per organization. There are no
 * sources in S2, so every answer is no. A source that fails fails the question and is asked again next time, so a
 * hiccup never turns a paid feature off for a minute; the callers fail the request or the job, never allow it.
 */
export const createEntitlements = (options: EntitlementsOptions): Entitlements => {
  const cache = new Map<string, Cached>();

  const namesOf = async (orgId: string): Promise<ReadonlySet<string>> => {
    const now = options.now();
    const cached = cache.get(orgId);
    if (cached !== undefined && cached.expiresAt > now) {
      return await cached.names;
    }
    cache.delete(orgId);
    if (cache.size >= MAX_CACHED_ORGS) {
      const oldest = cache.keys().next();
      if (oldest.done !== true) {
        cache.delete(oldest.value);
      }
    }
    const names = askSources(options.sources, orgId);
    const entry: Cached = { expiresAt: now + ENTITLEMENT_TTL_MS, names };
    cache.set(orgId, entry);
    try {
      return await names;
    } catch (error) {
      if (cache.get(orgId) === entry) {
        cache.delete(orgId);
      }
      throw error;
    }
  };

  return (orgId) => ({
    has: async (name) => (await namesOf(orgId)).has(name),
    list: async () => [...(await namesOf(orgId))].sort(),
    forget: () => {
      cache.delete(orgId);
    },
  });
};

/**
 * Drops an organization's cached entitlements when `entitlements.changed` is published, so the SDK sessions the
 * endpoint closes for it agree on the new modules when they reconnect.
 */
export const forgetOnChange = (bus: EventBus, entitlements: Entitlements): void => {
  bus.subscribe((event) => {
    if (event.type === "entitlements.changed") {
      entitlements(event.orgId).forget();
    }
  });
};
