import type { Hello } from "@micafox/protocol";

import { cutFields } from "./fields.js";
import type { InstanceFields } from "./fields.js";
import { OnlineInstances } from "./online.js";
import type { OnlineInstance } from "./online.js";
import { deleteInstancesSeenBefore, upsertInstance, writeLastSeen } from "./queries.js";
import { addInstanceRoutes } from "./routes.js";
import type { Authorization, KeyScope } from "../../access/index.js";
import type { HubApp } from "../../app/index.js";
import type { Database } from "../../db/index.js";
import { SYSTEM_ACTOR } from "../../events/index.js";
import type { EventBus } from "../../events/index.js";

/** Offline instances are deleted once they have not been seen this long. */
const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/** What the instances need from the hub. */
export interface InstancesOptions {
  db: Database;
  bus: EventBus;
  now: () => number;
  warnCollapsed: (key: string, fields: Record<string, unknown>, message: string) => void;
}

/** A session whose `hello` was accepted. */
export interface TrackedSession {
  key: KeyScope;
  hello: Hello;
  /** The modules `welcome` listed. */
  modules: readonly string[];
  /** Settles when the session's socket closes. */
  closed: Promise<void>;
}

/** What `track` found in a `hello`, for the endpoint to count. */
export interface Tracked {
  /** Fields and labels cut to fit, and a `pid` that had to change. */
  cut: number;
  /** NUL characters and unpaired surrogates replaced with U+FFFD. */
  replaced: number;
}

/** The connected instances: docs/architecture/hub/sdk-endpoint.md#keeping-instances. */
export interface Instances {
  /**
   * Records the instance of an accepted `hello` and keeps it online until the session closes: upserts its row,
   * publishes `instance.connected`, and on close writes `last_seen_at` and publishes `instance.disconnected`. A
   * session that a newer one of the same instance replaced does neither. It never rejects: a write that fails is
   * logged, and the session stays.
   */
  track: (session: TrackedSession) => Promise<Tracked>;
  /** Writes `last_seen_at` of every instance this replica holds a session for; the job runs it every minute. */
  writeLastSeen: () => Promise<void>;
  /** Deletes the instances not seen for 7 days; the job runs it every hour. */
  deleteStale: () => Promise<void>;
  /** Adds `GET /api/v1/environments/{environmentId}/instances` to the app, inside the scope that has the actor. */
  addRoutes: (app: HubApp, authorization: Authorization) => void;
  /** Settles once every session that closed has been written, so the stop does not close the database under it. */
  idle: () => Promise<void>;
}

interface Parts extends InstancesOptions {
  online: OnlineInstances;
}

const publish = (parts: Parts, type: string, instance: OnlineInstance): void => {
  const { orgId, environmentId, instanceId } = instance;
  parts.bus.publish({ type, orgId, environmentId, actor: SYSTEM_ACTOR, data: { environmentId, instanceId } });
};

// Writes the row and tells the screens; a failure is logged and the session goes on without a row until it reconnects
const record = async (
  parts: Parts,
  entry: OnlineInstance,
  write: { key: KeyScope; fields: InstanceFields },
): Promise<boolean> => {
  const { key, fields } = write;
  try {
    await parts.db.forOrg(key.orgId, async (trx) => {
      const owner = { ...entry, projectId: key.projectId, keyPrefix: key.prefix };
      const onlineIds = parts.online.idsOf(entry.environmentId);
      await upsertInstance(trx, { owner, fields, onlineIds, at: new Date(parts.now()) });
    });
  } catch (error) {
    parts.warnCollapsed(
      `instances.upsert-failed:${key.prefix}`,
      { err: error, keyPrefix: key.prefix, environmentId: entry.environmentId, instanceId: entry.instanceId },
      "instances.upsert-failed",
    );
    return false;
  }
  // A newer session of the instance announces itself; this one is already closing
  if (parts.online.isCurrent(entry)) {
    publish(parts, "instance.connected", entry);
  }
  return true;
};

// The session closed: unless a newer one replaced it, the instance is offline, seen now
const end = async (parts: Parts, entry: OnlineInstance, isRecorded: boolean): Promise<void> => {
  if (!parts.online.remove(entry)) {
    return;
  }
  try {
    await parts.db.forOrg(entry.orgId, async (trx) => {
      await writeLastSeen(trx, [entry], new Date(parts.now()));
    });
  } catch (error) {
    parts.warnCollapsed(
      "instances.last-seen-failed",
      { err: error, environmentId: entry.environmentId, instanceId: entry.instanceId },
      "instances.last-seen-failed",
    );
  }
  if (isRecorded) {
    publish(parts, "instance.disconnected", entry);
  }
};

const writeOnlineLastSeen = async (parts: Parts): Promise<void> => {
  const instances = parts.online.list();
  if (instances.length > 0) {
    await parts.db.system(
      "instances.last-seen",
      async (trx) => {
        await writeLastSeen(trx, instances, new Date(parts.now()));
      },
      { logLevel: "debug" },
    );
  }
};

const deleteExpired = async (parts: Parts): Promise<void> => {
  await parts.db.system(
    "instances.expire",
    async (trx) => {
      await deleteInstancesSeenBefore(trx, new Date(parts.now() - EXPIRY_MS));
    },
    { logLevel: "debug" },
  );
};

export const createInstances = (options: InstancesOptions): Instances => {
  const parts: Parts = { ...options, online: new OnlineInstances() };
  // What `idle` waits for: a recording in flight, and the write of each session that has closed
  const pending = new Set<Promise<unknown>>();
  const keep = (work: Promise<unknown>): void => {
    // Work never rejects, and if it ever did, neither `idle` nor an unheard rejection may fail with it
    const settled = work.then(
      () => undefined,
      () => undefined,
    );
    pending.add(settled);
    void settled.finally(() => pending.delete(settled));
  };

  const track = async (session: TrackedSession): Promise<Tracked> => {
    const { key, hello } = session;
    // Online from here, before any await, so sessions that replace each other are ordered as they registered
    const entry = parts.online.add({
      orgId: key.orgId,
      environmentId: key.environmentId,
      instanceId: hello.instanceId,
    });
    const { fields, cut, replaced } = cutFields(hello, session.modules);
    const isRecorded = await record(parts, entry, { key, fields });
    // The write of a close is work from the moment the session closes, not while it is open
    void session.closed.then(() => {
      keep(end(parts, entry, isRecorded));
    });
    return { cut, replaced };
  };

  return {
    track: async (session) => {
      const tracking = track(session);
      keep(tracking);
      return await tracking;
    },
    writeLastSeen: async () => {
      await writeOnlineLastSeen(parts);
    },
    deleteStale: async () => {
      await deleteExpired(parts);
    },
    addRoutes: (app, authorization) => {
      addInstanceRoutes(app, authorization, (environmentId) => parts.online.idsOf(environmentId));
    },
    idle: async () => {
      // A recording that settles adds the write of its session's close, so wait until nothing is left
      while (pending.size > 0) {
        await Promise.all([...pending]);
      }
    },
  };
};
