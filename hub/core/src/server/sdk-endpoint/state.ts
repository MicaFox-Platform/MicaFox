import type { Message } from "@micafox/protocol";
import { sql } from "kysely";
import type { Logger } from "pino";

import { CLOSE } from "./sessions.js";
import type { Connection, SdkSessions } from "./sessions.js";
import type { Database } from "../db/index.js";
import type { EventBus, HubEvent } from "../events/index.js";
import type { ProtocolModule, SdkApi, SdkSession } from "../feature/index.js";

/** The event `sdk.resend` publishes; the SDK endpoint of every replica listens for it, the events streams skip it. */
const RESEND_EVENT = "sdk.state.resend";

// A resend has no user behind it: it follows a change that a route, a job or the hub itself already committed
const SYSTEM_ACTOR = { userId: "system" };

/**
 * `sdk.resend` for the features: finds the organization of the environment and publishes the resend event on the
 * bus. It never throws, as it runs after the change it announces has committed.
 */
export const createSdkResend = (parts: { db: Database; bus: EventBus; log: Logger }): SdkApi => ({
  resend: async (environmentId, module) => {
    try {
      const orgId = await parts.db.system(
        "sdk.resend",
        async (db) => {
          const { rows } = await sql<{
            orgId: string;
          }>`select org_id as "orgId" from environments where id = ${environmentId}`.execute(db);
          return rows[0]?.orgId;
        },
        { logLevel: "debug" },
      );
      // An environment deleted since the change has no instance left to resend to
      if (orgId !== undefined) {
        parts.bus.publish({ type: RESEND_EVENT, orgId, environmentId, actor: SYSTEM_ACTOR, data: { module } });
      }
    } catch (error) {
      parts.log.warn({ err: error, environmentId, module }, "sdk.resend-failed");
    }
  },
});

/** What sending state needs from the endpoint. */
export interface StateOptions {
  sessions: SdkSessions;
  /** The module of each feature the hub runs, by name. */
  modules: ReadonlyMap<string, ProtocolModule>;
}

/** Sends the state of the features' modules to the sessions. */
export interface StateSender {
  /** Sends the state of each module of `welcome` to a session that has just been welcomed. */
  sendAll: (connection: Connection, modules: readonly string[]) => void;
  /** Sends the module's state again to the sessions of the event's environment that agreed on it. */
  onEvent: (event: HubEvent) => void;
}

// The asks in flight per connection and module, so it is gone with the connection. `isDirty` says another ask came
// while one was being read: it is answered by one more read once that one settles, however many came.
type InFlight = WeakMap<Connection, Map<string, { isDirty: boolean }>>;

// A state that cannot be written, such as a message that is not JSON, is a bug of the feature: the session closes
// with 1011 rather than keep a state that is half sent
const sendMessages = (sessions: SdkSessions, connection: Connection, messages: readonly Message[]): void => {
  try {
    for (const message of messages) {
      sessions.send(connection, JSON.stringify(message));
    }
  } catch (error) {
    connection.log.warn({ err: error }, "sdk.state-failed");
    sessions.close(connection, CLOSE.internalError);
  }
};

// Read through a function: another call of `sendState` sets the flag while this one awaits, which the compiler,
// looking at one function, cannot see
const wasOvertaken = (ask: { isDirty: boolean }): boolean => ask.isDirty;

const readState = async (
  module: ProtocolModule,
  session: SdkSession,
): Promise<{ messages: readonly Message[] } | { error: unknown }> => {
  try {
    return { messages: await module.state(session) };
  } catch (error) {
    return { error };
  }
};

// Reads the module's state for the session and sends it. The state is always complete, so a read that another ask
// overtook is dropped and read again: at most one read per session and module is in flight, a burst of resends costs
// two reads, and the last state sent is never older than the last ask.
const sendState = async (
  parts: { sessions: SdkSessions; inFlight: InFlight },
  connection: Connection,
  module: ProtocolModule,
): Promise<void> => {
  const { session } = connection;
  if (session === undefined) {
    return;
  }
  const ofConnection = parts.inFlight.get(connection) ?? new Map<string, { isDirty: boolean }>();
  parts.inFlight.set(connection, ofConnection);
  const running = ofConnection.get(module.module);
  if (running !== undefined) {
    running.isDirty = true;
    return;
  }
  const ask = { isDirty: false };
  ofConnection.set(module.module, ask);
  try {
    let result;
    do {
      ask.isDirty = false;
      result = await readState(module, session);
    } while (wasOvertaken(ask));
    if ("error" in result) {
      // The database is the usual reason: the SDK reconnects with backoff and asks again
      connection.log.warn({ err: result.error, module: module.module }, "sdk.state-failed");
      parts.sessions.close(connection, CLOSE.internalError);
      return;
    }
    sendMessages(parts.sessions, connection, result.messages);
  } finally {
    ofConnection.delete(module.module);
  }
};

/** Builds the sender of the features' state over the open sessions. */
export const createStateSender = (options: StateOptions): StateSender => {
  const { sessions, modules } = options;
  const parts: { sessions: SdkSessions; inFlight: InFlight } = { sessions, inFlight: new WeakMap() };
  return {
    sendAll: (connection, agreed) => {
      for (const name of agreed) {
        const module = modules.get(name);
        if (module !== undefined) {
          void sendState(parts, connection, module);
        }
      }
    },
    onEvent: (event) => {
      const name = event.data.module;
      if (event.type !== RESEND_EVENT || event.environmentId === undefined || typeof name !== "string") {
        return;
      }
      const module = modules.get(name);
      if (module === undefined) {
        return;
      }
      for (const connection of sessions.inEnvironment(event.environmentId, module.module)) {
        // The environment's organization is the key's; an event that says otherwise is not for this session
        if (connection.key.orgId === event.orgId) {
          void sendState(parts, connection, module);
        }
      }
    },
  };
};
