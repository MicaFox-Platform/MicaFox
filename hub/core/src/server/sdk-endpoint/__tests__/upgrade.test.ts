import { describe, expect, it } from "vitest";

import type { KeyScope } from "../../access/index.js";
import { checkLimits, checkUpgrade, KeyCache } from "../upgrade.js";
import type { UpgradeCheckOptions } from "../upgrade.js";

const TOKEN = `mfx_pk_${"a".repeat(43)}`;
const KEY: KeyScope = {
  keyId: "6f1c1d2b-8a01-4e55-9d0c-0b6f3a526a3e",
  prefix: TOKEN.slice(0, 12),
  orgId: "0b6f3a52-6a3e-4e55-9d0c-6f1c1d2b8a01",
  projectId: "4d1e9c07-21b4-4f0a-8c3e-0a9f7e5d6b02",
  environmentId: "9c3e0a9f-7e5d-4b02-8c3e-21b44f0a4d1e",
};

interface Setup {
  options: UpgradeCheckOptions;
  clock: { now: number };
  database: { key: KeyScope | undefined; isDown: boolean };
}

const setup = (overrides: Partial<UpgradeCheckOptions> = {}): Setup => {
  const clock = { now: 0 };
  const database: Setup["database"] = { key: KEY, isDown: false };
  const options: UpgradeCheckOptions = {
    cache: new KeyCache(() => clock.now),
    lookupKey: async (token) => {
      if (database.isDown) {
        throw new Error("connection refused");
      }
      return await Promise.resolve(token === TOKEN ? database.key : undefined);
    },
    counts: { total: () => 0, ofKey: () => 0 },
    limits: { maxConnections: 1000, maxConnectionsPerKey: 500 },
    ...overrides,
  };
  return { options, clock, database };
};

const bearer = (token: string): string => `Bearer ${token}`;

// Caches `count` other keys, as many apps of many organizations connect
const fillCache = (cache: KeyCache, count: number): void => {
  for (let index = 0; index < count; index += 1) {
    cache.remember(`hash-${String(index)}`, { ...KEY, keyId: `key-${String(index)}` });
  }
};

describe("KeyCache", () => {
  it("drops the oldest key past 10,000", () => {
    const cache = new KeyCache(() => 0);
    cache.remember("first", KEY);

    fillCache(cache, 10_000);

    expect([cache.find("first"), cache.find("hash-9999")]).toEqual([undefined, { ...KEY, keyId: "key-9999" }]);
  });
});

describe("checkUpgrade", () => {
  it("answers the key of an active project key", async () => {
    const { options } = setup();

    expect(await checkUpgrade(bearer(TOKEN), options)).toEqual({ key: KEY });
  });

  it("refuses a request without a bearer token with unauthenticated", async () => {
    const { options } = setup();

    const decisions = [await checkUpgrade(undefined, options), await checkUpgrade(`Basic ${TOKEN}`, options)];

    expect(decisions.map((decision) => "refusal" in decision && decision.refusal.problem)).toEqual([
      "unauthenticated",
      "unauthenticated",
    ]);
  });

  it("refuses a token that is not a project key with forbidden, without asking the database", async () => {
    const { options, database } = setup();
    database.isDown = true;

    expect(await checkUpgrade(bearer("mfx_ses_abc"), options)).toMatchObject({ refusal: { problem: "forbidden" } });
  });

  it("refuses an unknown or revoked key with forbidden", async () => {
    const { options, database } = setup();
    database.key = undefined;

    expect(await checkUpgrade(bearer(TOKEN), options)).toMatchObject({ refusal: { problem: "forbidden" } });
  });

  it("refuses with rate-limited when the replica has its most connections", async () => {
    const { options } = setup({ counts: { total: () => 1000, ofKey: () => 0 } });

    expect(await checkUpgrade(bearer(TOKEN), options)).toMatchObject({ refusal: { problem: "rate-limited" } });
  });

  it("lets a key found in the last 60 s connect while the database is down", async () => {
    const { options, clock, database } = setup();
    await checkUpgrade(bearer(TOKEN), options);
    database.isDown = true;
    clock.now = 59_999;

    expect(await checkUpgrade(bearer(TOKEN), options)).toEqual({ key: KEY });
  });

  it("throws for a key not cached while the database is down", async () => {
    const { options, clock, database } = setup();
    await checkUpgrade(bearer(TOKEN), options);
    database.isDown = true;
    clock.now = 60_000;

    await expect(checkUpgrade(bearer(TOKEN), options)).rejects.toThrow("connection refused");
  });

  it("refuses a revoked key at once, even when a lookup still finds it", async () => {
    const { options } = setup();
    await checkUpgrade(bearer(TOKEN), options);

    options.cache.revoke(KEY.keyId);

    expect(await checkUpgrade(bearer(TOKEN), options)).toMatchObject({ refusal: { problem: "forbidden" } });
  });

  it("asks the database again 60 s after a revoke", async () => {
    const { options, clock } = setup();
    options.cache.revoke(KEY.keyId);
    clock.now = 60_000;

    expect(await checkUpgrade(bearer(TOKEN), options)).toEqual({ key: KEY });
  });
});

describe("checkLimits", () => {
  const limits = { maxConnections: 1000, maxConnectionsPerKey: 500 };

  it("lets a connection through below both limits", () => {
    expect(checkLimits(KEY, { counts: { total: () => 999, ofKey: () => 499 }, limits })).toBeUndefined();
  });

  it("refuses with rate-limited when the replica has its most connections", () => {
    expect(checkLimits(KEY, { counts: { total: () => 1000, ofKey: () => 0 }, limits })).toMatchObject({
      problem: "rate-limited",
    });
  });

  it("refuses with rate-limited when the key has its most connections", () => {
    expect(checkLimits(KEY, { counts: { total: () => 500, ofKey: () => 500 }, limits })).toMatchObject({
      problem: "rate-limited",
    });
  });
});
