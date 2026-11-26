import websocket from "@fastify/websocket";
import type { WebSocket } from "@fastify/websocket";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { IncomingMessage } from "node:http";
import type { Logger } from "pino";

import { startHandshake } from "./handshake.js";
import type { Instances, TrackedSession } from "./instances/index.js";
import { createLiveness } from "./liveness.js";
import type { Liveness } from "./liveness.js";
import { createSdkCounts, startRouting } from "./routing.js";
import type { SdkCounts } from "./routing.js";
import { CLOSE, SdkSessions } from "./sessions.js";
import type { Connection } from "./sessions.js";
import { createStateSender } from "./state.js";
import type { StateSender } from "./state.js";
import { checkLimits, checkUpgrade, KeyCache } from "./upgrade.js";
import type { Refusal, UpgradeCheckOptions } from "./upgrade.js";
import type { Access, KeyUses } from "../access/index.js";
import { sendProblem } from "../app/index.js";
import type { HubApp } from "../app/index.js";
import type { Settings } from "../config/index.js";
import type { EventBus } from "../events/index.js";
import type { Gate, ProtocolModule } from "../feature/index.js";
import type { Timers } from "../observability/index.js";

export { createInstances } from "./instances/index.js";
export type { Instances, Tracked, TrackedSession } from "./instances/index.js";
export { createSdkResend } from "./state.js";
export type { SdkCounts, SdkCountName } from "./routing.js";

/** The path the SDK connects to: `MICAFOX_HUB_URL` is `wss://<hub>/sdk`. */
const SDK_PATH = "/sdk";

/** What the SDK endpoint needs from the hub. */
export interface SdkEndpointOptions {
  settings: Pick<
    Settings,
    "sdkMaxFrameBytes" | "sdkMaxConnections" | "sdkMaxConnectionsPerKey" | "sdkMaxMessagesPerSecond"
  >;
  access: Access;
  keyUses: KeyUses;
  gate: Gate;
  /** The SDK module of each feature the hub runs. */
  modules: readonly ProtocolModule[];
  bus: EventBus;
  /** The connected instances each accepted `hello` is recorded in. */
  instances: Instances;
  log: Logger;
  warnCollapsed: (key: string, fields: Record<string, unknown>, message: string) => void;
  clock: Timers & { now: () => number };
}

/** The SDK endpoint as the hub's stop uses it. */
export interface SdkEndpoint {
  /** Closes every SDK connection with 1001 and settles once they have closed. */
  closeAll: () => Promise<void>;
  /** What the endpoint dropped or repaired since the hub started, for the metrics. */
  counts: SdkCounts["list"];
}

interface Parts {
  options: SdkEndpointOptions;
  sessions: SdkSessions;
  liveness: Liveness;
  check: UpgradeCheckOptions;
  /** The connection each request reserved in its key check. */
  connections: WeakMap<IncomingMessage, Connection>;
  counts: SdkCounts;
  state: StateSender;
  modules: ReadonlyMap<string, ProtocolModule>;
}

// Node marks a request that came through `upgrade`; its socket left the HTTP parser, so after an HTTP answer nothing
// would ever read or close it. Node's types leave the field out.
const isUpgrade = (request: FastifyRequest): boolean => Reflect.get(request.raw, "upgrade") === true;

// Every upgrade that is not for /sdk ends with an HTTP answer and its socket closed, the readiness gate's 503 too
const guardOtherUpgrades = (app: HubApp): void => {
  app.addHook("onRequest", async (request, reply) => {
    if (isUpgrade(request) && request.routeOptions.url !== SDK_PATH) {
      await sendProblem(reply, "not-found");
    }
  });
  app.addHook("onResponse", (request, _reply, done) => {
    if (isUpgrade(request)) {
      request.raw.socket.destroy();
    }
    done();
  });
};

const refuseUpgrade = async (parts: Parts, reply: FastifyReply, refusal: Refusal): Promise<void> => {
  const { problem, detail } = refusal;
  parts.options.warnCollapsed(`sdk.key-rejected:${problem}`, { problem }, "sdk.key-rejected");
  await sendProblem(reply, problem, { detail });
};

// The key check before the upgrade: refused with a problem, or the connection reserved, so it counts at once
const checkKey = async (parts: Parts, request: FastifyRequest, reply: FastifyReply): Promise<void> => {
  const { options } = parts;
  if (!isUpgrade(request)) {
    await sendProblem(reply, "not-found");
    return;
  }
  let decision;
  try {
    decision = await checkUpgrade(request.headers.authorization, parts.check);
  } catch (error) {
    options.warnCollapsed("sdk.key-lookup-failed", { err: error }, "sdk.key-lookup-failed");
    await sendProblem(reply, "not-ready", { detail: "The hub cannot check the project key now" });
    return;
  }
  if ("refusal" in decision) {
    await refuseUpgrade(parts, reply, decision.refusal);
    return;
  }
  const { key } = decision;
  // No await between the limits and the reservation: another check cannot slip in between
  const limited = checkLimits(key, parts.check);
  if (limited !== undefined) {
    await refuseUpgrade(parts, reply, limited);
    return;
  }
  const log = options.log.child({ keyPrefix: key.prefix, orgId: key.orgId, environmentId: key.environmentId });
  parts.connections.set(request.raw, parts.sessions.reserve(key, request.raw.socket, log));
  options.keyUses.note(key.keyId);
  parts.liveness.watch();
};

// A frame of any kind, a ping included, keeps the connection alive; a ping also notes the key's use
const watchActivity = (parts: Parts, connection: Connection, socket: WebSocket): void => {
  const { sessions } = parts;
  socket.on("message", () => {
    sessions.touch(connection);
  });
  socket.on("pong", () => {
    sessions.touch(connection);
  });
  socket.on("ping", () => {
    sessions.touch(connection);
    parts.options.keyUses.note(connection.key.keyId);
  });
  socket.on("close", (code: number) => {
    connection.log.info({ code }, "sdk.disconnected");
  });
};

// Records the instance; what the hub had to cut or repair in its `hello` is counted, with a collapsed warning. Nothing
// it does may reject unheard, which would crash the hub
const trackInstance = (parts: Parts, session: TrackedSession): void => {
  const { options, counts } = parts;
  const { key } = session;
  const tracking = options.instances.track(session).then(({ cut, replaced }) => {
    if (replaced > 0) {
      counts.add("sanitized", replaced);
    }
    if (cut > 0) {
      counts.add("cut", cut);
    }
    if (cut > 0 || replaced > 0) {
      options.warnCollapsed(
        `sdk.hello-cut:${key.prefix}`,
        { keyPrefix: key.prefix, environmentId: key.environmentId, cut, replaced },
        "sdk.hello-cut",
      );
    }
  });
  tracking.catch((error: unknown) => {
    options.log.error({ err: error, keyPrefix: key.prefix }, "sdk.instance-track-failed");
  });
};

const openSession = (parts: Parts, socket: WebSocket, request: FastifyRequest): void => {
  const connection = parts.connections.get(request.raw);
  if (connection === undefined) {
    // Only a request that passed the key check reaches the handler
    socket.terminate();
    return;
  }
  watchActivity(parts, connection, socket);
  parts.sessions.attach(connection, socket);
  startHandshake(connection, socket, {
    sessions: parts.sessions,
    gate: parts.options.gate,
    timers: parts.options.clock,
    warnCollapsed: parts.options.warnCollapsed,
    onWelcomed: (welcomed, modules, hello) => {
      startRouting(welcomed, socket, {
        sessions: parts.sessions,
        modules: parts.modules,
        counts: parts.counts,
        maxMessagesPerSecond: parts.options.settings.sdkMaxMessagesPerSecond,
        now: parts.options.clock.now,
        warnCollapsed: parts.options.warnCollapsed,
      });
      parts.state.sendAll(welcomed, modules);
      trackInstance(parts, { key: welcomed.key, hello, modules, closed: welcomed.closed });
    },
  });
};

// A socket error is the peer's, such as a reset or a frame over the limit, which ws closes itself with its code
const onSocketError = (parts: Parts, error: Error, request: FastifyRequest): void => {
  const connection = parts.connections.get(request.raw);
  const log = connection?.log ?? request.log;
  log.debug({ err: error }, "sdk.socket-error");
};

const addSdkRoute = (app: HubApp, parts: Parts): void => {
  void app.register(websocket, {
    options: { maxPayload: parts.options.settings.sdkMaxFrameBytes, perMessageDeflate: false },
    errorHandler: (error, _socket, request) => {
      onSocketError(parts, error, request);
    },
    // The stop closed the sessions before the drain; what is left is cut off, so the drain never waits on a peer
    preClose(done) {
      for (const client of this.websocketServer.clients) {
        client.terminate();
      }
      this.websocketServer.close();
      done();
    },
  });
  void app.register((scope: HubApp, _options, done) => {
    scope.get(
      SDK_PATH,
      {
        websocket: true,
        preValidation: async (request, reply) => {
          await checkKey(parts, request, reply);
        },
      },
      (socket, request) => {
        openSession(parts, socket, request);
      },
    );
    done();
  });
};

const subscribeToChanges = (parts: Parts): void => {
  const { options, sessions, check } = parts;
  options.access.onKeyRevoked((key) => {
    check.cache.revoke(key.keyId);
    sessions.closeKey(key.keyId, CLOSE.policyViolation);
  });
  // The modules a session agreed on depend on the entitlements, so the SDK reconnects to agree on them again
  options.bus.subscribe((event) => {
    if (event.type === "entitlements.changed") {
      sessions.closeOrg(event.orgId, CLOSE.goingAway);
    }
    parts.state.onEvent(event);
  });
};

/**
 * Adds `GET /sdk`, the WebSocket every SDK connector opens, and closes every other upgrade attempt:
 * docs/architecture/hub/sdk-endpoint.md.
 */
export const addSdkEndpoint = (app: HubApp, options: SdkEndpointOptions): SdkEndpoint => {
  const { clock, settings } = options;
  const sessions = new SdkSessions({ timers: clock, now: clock.now });
  const modules = new Map(options.modules.map((module) => [module.module, module]));
  const counts = createSdkCounts();
  const parts: Parts = {
    options,
    sessions,
    liveness: createLiveness({ sessions, timers: clock, now: clock.now }),
    check: {
      cache: new KeyCache(clock.now),
      lookupKey: options.access.lookupKey,
      counts: { total: () => sessions.size, ofKey: (keyId) => sessions.countOfKey(keyId) },
      limits: { maxConnections: settings.sdkMaxConnections, maxConnectionsPerKey: settings.sdkMaxConnectionsPerKey },
    },
    connections: new WeakMap(),
    counts,
    state: createStateSender({ sessions, modules }),
    modules,
  };
  guardOtherUpgrades(app);
  addSdkRoute(app, parts);
  subscribeToChanges(parts);
  return {
    closeAll: async () => {
      await sessions.closeAll(CLOSE.goingAway);
      await options.instances.idle();
      parts.liveness.stop();
    },
    counts: counts.list,
  };
};
