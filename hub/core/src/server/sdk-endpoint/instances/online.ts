/** An instance this replica holds a session for. */
export interface OnlineInstance {
  orgId: string;
  environmentId: string;
  instanceId: string;
}

/**
 * The instances this replica holds a session for, by environment: nothing in the table says whether one is online,
 * so a crash or a lost database never leaves an instance online. A session that replaces another of the same
 * instance takes its place, and the replaced one is no longer current.
 * It mirrors the registered sessions of `SdkSessions` because the instances are built before the endpoint, for the
 * jobs and the routes; `track` adds an instance as its session registers and removes it as the session closes.
 */
export class OnlineInstances {
  private readonly byEnvironment = new Map<string, Map<string, OnlineInstance>>();

  /** Marks the instance online; the returned entry is what `remove` takes, so only the current session removes it. */
  add(instance: OnlineInstance): OnlineInstance {
    const entry = { ...instance };
    const inEnvironment = this.byEnvironment.get(entry.environmentId) ?? new Map<string, OnlineInstance>();
    inEnvironment.set(entry.instanceId, entry);
    this.byEnvironment.set(entry.environmentId, inEnvironment);
    return entry;
  }

  /** Marks the instance offline unless a newer session replaced `entry`; answers whether it was current. */
  remove(entry: OnlineInstance): boolean {
    const inEnvironment = this.byEnvironment.get(entry.environmentId);
    if (inEnvironment === undefined || !this.isCurrent(entry)) {
      return false;
    }
    inEnvironment.delete(entry.instanceId);
    if (inEnvironment.size === 0) {
      this.byEnvironment.delete(entry.environmentId);
    }
    return true;
  }

  /** Whether `entry` is still the session the instance is online with. */
  isCurrent(entry: OnlineInstance): boolean {
    return this.byEnvironment.get(entry.environmentId)?.get(entry.instanceId) === entry;
  }

  /** The `instanceId` of every online instance of an environment. */
  idsOf(environmentId: string): string[] {
    return [...(this.byEnvironment.get(environmentId)?.keys() ?? [])];
  }

  /** Every online instance of this replica. */
  list(): OnlineInstance[] {
    return [...this.byEnvironment.values()].flatMap((inEnvironment) => [...inEnvironment.values()]);
  }
}
