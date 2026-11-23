import { sql } from "kysely";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isOnPostgres, TEST_DATABASE_URL } from "../../../../test/db/test-database.js";
import { envOf, TEST_MODE_LINES } from "../../../../test/server/env.js";
import { get } from "../../../../test/server/http.js";
import { captureLog } from "../../../../test/server/log-capture.js";
import type { LogCapture } from "../../../../test/server/log-capture.js";
import { createHub, runHub } from "../index.js";
import type { Hub } from "../index.js";

// A port free a moment ago: outside the test mode the public URL is required, and must name the port the hub binds
const freePort = async (): Promise<number> => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
};

const postgresLines = async (databaseUrl: string): Promise<string[]> => {
  const port = String(await freePort());
  return [
    `MICAFOX_DATABASE_URL=${databaseUrl}`,
    `MICAFOX_PUBLIC_URL=http://localhost:${port}`,
    "MICAFOX_HOST=127.0.0.1",
    `MICAFOX_PORT=${port}`,
  ];
};

// Nothing listens on port 1, so every connection is refused at once
const UNREACHABLE_URL = "postgres://micafox:secret@127.0.0.1:1/micafox";

const hubs: Hub[] = [];

const create = (lines: readonly string[]): { hub: Hub; log: LogCapture } => {
  const log = captureLog();
  const hub = createHub({ env: envOf(lines), version: "1", build: "hub", features: [], logStream: log.stream });
  hubs.push(hub);
  return { hub, log };
};

afterEach(async () => {
  await Promise.all(hubs.splice(0).map(async (hub) => await hub.stop()));
  vi.useRealTimers();
});

describe("the hub's database", () => {
  it("gives the parts a database that runs as the app role once the hub is ready", async () => {
    const { hub } = create(TEST_MODE_LINES);
    const running = await hub.start();
    await running.ready;

    const role = await hub.db.system("test", async (trx) => {
      const { rows } = await sql<{ role: string }>`select current_user as role`.execute(trx);
      return rows[0]?.role;
    });

    expect(role).toBe("micafox_app");
  });

  it("stops cleanly when it never started, without opening the database", async () => {
    const { hub, log } = create(TEST_MODE_LINES);

    const result = await hub.stop();

    expect(result).toEqual({ clean: true });
    expect(log.text()).not.toContain("PGlite");
  });

  it("stays not ready, warning once, while the database is unreachable, and stops cleanly", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { hub, log } = create(await postgresLines(UNREACHABLE_URL));
    const running = await hub.start();
    const unreachable = (): unknown[] =>
      log.lines().filter((line) => line.msg === "The database is unreachable; retrying");
    await vi.waitFor(() => {
      expect(unreachable()).toHaveLength(1);
    });

    await vi.advanceTimersByTimeAsync(250 + 500 + 1000);

    await expect(get(running.url, "/readyz")).resolves.toMatchObject({ status: 503 });
    expect(unreachable()).toHaveLength(1);
    expect(log.text()).not.toContain("secret");
    await expect(hub.stop()).resolves.toEqual({ clean: true });
    await expect(running.ready).rejects.toThrow("aborted");
  });
});

describe.runIf(isOnPostgres)("the hub's database role on Postgres", () => {
  it("exits with 1 when the hub connects as a superuser", async () => {
    const log = captureLog();
    let exit: (code: number) => void = () => undefined;
    const exited = new Promise<number>((resolve) => {
      exit = resolve;
    });

    await runHub(
      { version: "1", build: "hub", features: [] },
      {
        env: envOf(await postgresLines(TEST_DATABASE_URL ?? "")),
        stdout: log.stream,
        stderr: { write: () => true },
        on: () => undefined,
        exit: (code) => {
          exit(code);
        },
      },
    );

    await expect(exited).resolves.toBe(1);
    expect(log.lines()).toContainEqual(
      expect.objectContaining({
        msg: "The hub could not start",
        err: expect.objectContaining({
          step: "database",
          message: expect.stringContaining("database") as unknown,
        }) as unknown,
      }),
    );
    expect(log.text()).toContain("SUPERUSER");
  });
});
