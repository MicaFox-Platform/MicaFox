import type { KeyRevokedListener, KeyScope } from "../../src/server/access/index.js";
import { createEntitlements } from "../../src/server/access/index.js";
import { createEvents } from "../../src/server/events/index.js";
import type { EventBus } from "../../src/server/events/index.js";
import { createFeatureRegistry, createGate, defineExtension } from "../../src/server/feature/index.js";
import type { Gate } from "../../src/server/feature/index.js";
import { addSdkEndpoint } from "../../src/server/sdk-endpoint/index.js";
import type { SdkEndpoint, SdkEndpointOptions } from "../../src/server/sdk-endpoint/index.js";
import { emptyFeature, paidFeature, protocolModule } from "../feature/fixtures.js";
import { createTestApp } from "../server/app.js";
import type { LogCapture } from "../server/log-capture.js";
import { createManualClock } from "../server/manual-clock.js";
import type { ManualClock } from "../server/manual-clock.js";

export const ORG_A = "0b6f3a52-6a3e-4e55-9d0c-6f1c1d2b8a01";
export const ORG_B = "4d1e9c07-21b4-4f0a-8c3e-0a9f7e5d6b02";

/** A well-formed project key token that ends with `suffix`. */
export const tokenOf = (suffix: string): string => `mfx_pk_${suffix.padStart(43, "x")}`;

/** The key a token of `tokenOf(suffix)` leads to, in organization A's production unless overridden. */
export const keyOf = (suffix: string, overrides: Partial<KeyScope> = {}): KeyScope => ({
  keyId: `key-${suffix}`,
  prefix: tokenOf(suffix).slice(0, 12),
  orgId: ORG_A,
  projectId: "project-1",
  environmentId: "production",
  ...overrides,
});

/** The SDK endpoint alone on a listening app, with keys in memory instead of a database. */
export interface EndpointApp {
  url: string;
  log: LogCapture;
  manual: ManualClock;
  bus: EventBus;
  endpoint: SdkEndpoint;
  /** The active keys by token; a test adds and removes them. */
  keys: Map<string, KeyScope>;
  /** Makes every key lookup fail, as when Postgres is down, or wait until `hold` settles. */
  database: { isDown: boolean; hold?: Promise<void>; lookups: number };
  /** The ids of the keys the endpoint noted as used, in order. */
  usedKeys: string[];
  /** Revokes a key as access does: drops it and runs the revoke listeners. */
  revoke: (token: string) => Promise<void>;
  close: () => Promise<void>;
}

interface FakeAccess {
  access: SdkEndpointOptions["access"];
  revoke: EndpointApp["revoke"];
}

// Access over keys in memory: a lookup finds them by token, a revoke drops one and runs the listeners
const createFakeAccess = (keys: Map<string, KeyScope>, database: EndpointApp["database"]): FakeAccess => {
  const listeners: KeyRevokedListener[] = [];
  return {
    access: {
      lookupKey: async (token) => {
        database.lookups += 1;
        await database.hold;
        if (database.isDown) {
          throw new Error("connection refused");
        }
        return await Promise.resolve(keys.get(token));
      },
      onKeyRevoked: (listener) => {
        listeners.push(listener);
      },
    },
    revoke: async (token) => {
      const key = keys.get(token);
      keys.delete(token);
      for (const listener of listeners) {
        if (key !== undefined) {
          await listener(key);
        }
      }
    },
  };
};

// A core feature serves `debugger`; an extension feature serves `profiler`, which no organization may use
const createTestGate = (now: () => number): Gate =>
  createGate(
    createFeatureRegistry(
      [emptyFeature("debugger", { protocol: protocolModule("debugger") })],
      defineExtension({ features: [paidFeature("profiler", { protocol: protocolModule("profiler") })] }),
    ),
    createEntitlements({ sources: [], now }),
  );

/** Starts the endpoint with the test gate. Organization A has the key of `tokenOf("a")`. */
export const openEndpointApp = async (
  settings: Partial<SdkEndpointOptions["settings"]> = {},
  gate?: Gate,
): Promise<EndpointApp> => {
  const { app, log } = createTestApp();
  const manual = createManualClock();
  const { bus } = createEvents({ log: app.log, timers: manual.clock });
  const keys = new Map([[tokenOf("a"), keyOf("a")]]);
  const database: EndpointApp["database"] = { isDown: false, lookups: 0 };
  const usedKeys: string[] = [];
  const { access, revoke } = createFakeAccess(keys, database);
  const endpoint = addSdkEndpoint(app, {
    settings: { sdkMaxFrameBytes: 1_048_576, sdkMaxConnections: 1000, sdkMaxConnectionsPerKey: 500, ...settings },
    access,
    keyUses: {
      note: (keyId) => {
        usedKeys.push(keyId);
      },
      write: async () => {
        await Promise.resolve();
      },
    },
    gate: gate ?? createTestGate(manual.clock.now),
    bus,
    log: app.log,
    warnCollapsed: (_key, fields, message) => {
      app.log.warn(fields, message);
    },
    clock: manual.clock,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  return {
    url: `http://127.0.0.1:${String(app.addresses()[0]?.port)}`,
    log,
    manual,
    bus,
    endpoint,
    keys,
    database,
    usedKeys,
    revoke,
    close: async () => {
      await endpoint.closeAll();
      await app.close();
    },
  };
};
