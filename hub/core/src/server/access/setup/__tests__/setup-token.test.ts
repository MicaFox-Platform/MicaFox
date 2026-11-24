import { sql } from "kysely";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { HUB_URL, openSessionApp } from "../../../../../test/access/session-app.js";
import type { SessionApp } from "../../../../../test/access/session-app.js";
import { hashToken } from "../../tokens/index.js";
import { ensureSetupToken } from "../index.js";

let hub: SessionApp;

afterEach(async () => {
  await hub.close();
});

const storedHashes = async (): Promise<string[]> => {
  const result = await sql<{ hash: string }>`select token_hash as hash from credentials where kind = 'setup'`.execute(
    hub.test.db.global,
  );
  return result.rows.map((row) => row.hash);
};

const start = async (configuredToken?: string): Promise<void> => {
  await ensureSetupToken({
    db: hub.test.db,
    log: pino({}, hub.log.stream),
    publicUrl: () => HUB_URL,
    configuredToken,
  });
};

describe("ensureSetupToken", () => {
  it("stores the hash of a new mfx_setup_ token and logs the token once with the /setup URL", async () => {
    hub = await openSessionApp({ isEmpty: true });

    await start();

    const logged = /mfx_setup_[\w-]{43}/.exec(hub.log.text())?.[0] ?? "";
    expect([
      await storedHashes(),
      hub.log.text().split(logged).length - 1,
      hub.log.text().includes(`${HUB_URL}/setup`),
    ]).toEqual([[hashToken(logged)], 1, true]);
  });

  it("replaces the token of an earlier start, so only the latest one works", async () => {
    hub = await openSessionApp({ isEmpty: true });
    await start();
    const first = /mfx_setup_[\w-]{43}/.exec(hub.log.text())?.[0] ?? "";

    await start();

    expect(await storedHashes()).not.toContain(hashToken(first));
    expect(await storedHashes()).toHaveLength(1);
  });

  it("stores the hash of MICAFOX_SETUP_TOKEN instead and never logs it", async () => {
    hub = await openSessionApp({ isEmpty: true });

    await start("my-automation-token");

    expect([await storedHashes(), hub.log.text().includes("my-automation-token")]).toEqual([
      [hashToken("my-automation-token")],
      false,
    ]);
  });

  it("creates nothing once an owner exists", async () => {
    hub = await openSessionApp();

    await start();

    expect([await storedHashes(), hub.log.text()]).toEqual([[], ""]);
  });
});
