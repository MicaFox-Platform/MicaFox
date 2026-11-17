// Every example app in its own container, as compose.test.yaml locks it down: PID 1, non-root, read-only root
// filesystem, 256 MB. The containers start once for the whole file (global-setup.ts) and the fake hub's container prints
// what every app sends, so each test waits on the lines of its own breakpoint. The SIGTERM tests stop the containers,
// so they come last.

import type { Snapshot } from "@micafox/protocol";
import { afterAll, describe, expect, it } from "vitest";

import { readType } from "../../src/child-process-run.js";
import { readStatus, waitForStatus } from "../../src/hub.js";
import { fetchInARow } from "../../src/requests.js";
import { DOCKER_APPS, findQuoteLine, toQuoteFilePattern, toQuoteUrl, type DockerApp } from "../apps.js";
import { followHub, readServiceLines, stopService } from "../stack.js";

const REQUESTS = 20;
// Requests fetchUntilSnapshot() sends at most: a test that fails keeps no loop running into the next ones
const MAX_SNAPSHOT_ATTEMPTS = 200;
const SDK_LOG_PREFIX = "[micafox]";

const hub = followHub();

afterAll(async () => {
  hub.stop("SIGTERM");
  await hub.exited;
});

const readSnapshot = (line: string): Snapshot | undefined =>
  readType(line) === "snapshot" ? (JSON.parse(line) as Snapshot) : undefined;

// Each app gets only its own breakpoint (compose.test.yaml), so the id tells whose snapshot it is
const isSnapshotOf = (app: DockerApp, line: string): boolean => readSnapshot(line)?.breakpointId === app.breakpointId;

const countSnapshots = (app: DockerApp): number => hub.lines.filter((line) => isSnapshotOf(app, line)).length;

const isStatusOf = (app: DockerApp, status: string, line: string): boolean => {
  const candidate = readStatus(line);
  return candidate?.breakpointId === app.breakpointId && candidate.status === status;
};

/**
 * Resolves once `app`'s breakpoint is active now, not just once before: after a burst of requests it is `rateLimited`
 * until its tokens refill, and a request then captures nothing.
 */
const waitUntilActive = async (app: DockerApp): Promise<void> => {
  const last = hub.lines.findLast((line) => readStatus(line)?.breakpointId === app.breakpointId);
  if (last !== undefined && isStatusOf(app, "active", last)) {
    return;
  }

  const seen = hub.lines.filter((line) => isStatusOf(app, "active", line)).length;
  await hub.waitForLines((line) => isStatusOf(app, "active", line), seen + 1);
};

/**
 * Sends requests until the hub has printed a snapshot of `app`. A fresh process's first pauses can use up its pause
 * budget, so those requests capture nothing; a snapshot cut short still has its stack.
 */
const fetchUntilSnapshot = async (app: DockerApp): Promise<Snapshot | undefined> => {
  const state = { isSettled: false };
  const found = hub
    .waitForLines((line) => isSnapshotOf(app, line))
    .finally(() => {
      state.isSettled = true;
    });
  for (let attempt = 0; attempt < MAX_SNAPSHOT_ATTEMPTS && !state.isSettled; attempt += 1) {
    await fetchInARow(toQuoteUrl(app), 1);
  }
  if (!state.isSettled) {
    throw new Error(`no snapshot of ${app.breakpointId} after ${String(MAX_SNAPSHOT_ATTEMPTS)} requests`);
  }
  const [line = ""] = await found;
  return readSnapshot(line);
};

describe.each(DOCKER_APPS)("the $service container", (app) => {
  it("reports its breakpoint as active", async () => {
    // A framework loads a route's chunk on its first request, and the breakpoint stays pending until then; the first
    // status can also be pending while a source map is read or the bundles are searched
    await fetchInARow(toQuoteUrl(app), 1);
    const status = await waitForStatus(hub, app.breakpointId, (candidate) => candidate.status !== "pending");

    expect(status.status).toBe("active");
  });

  it("answers every request while the SDK runs", async () => {
    const statuses = await fetchInARow(toQuoteUrl(app), REQUESTS);

    expect(statuses).toEqual(Array.from({ length: REQUESTS }, () => 200));
  });

  it("logs no SDK error under a read-only root filesystem and 256 MB", () => {
    const sdkLines = readServiceLines(app.service).filter((line) => line.includes(SDK_LOG_PREFIX));

    expect(sdkLines).toEqual([]);
  });
});

describe.each(DOCKER_APPS)("the $service container's breakpoint", (app) => {
  it("captures a snapshot whose top frame is the marked line and keeps serving", async () => {
    await waitForStatus(hub, app.breakpointId, (status) => status.status === "active");

    const snapshot = await fetchUntilSnapshot(app);
    const statuses = await fetchInARow(toQuoteUrl(app), REQUESTS);

    expect({ file: snapshot?.stack[0]?.file, line: snapshot?.stack[0]?.line, statuses }).toEqual({
      file: expect.stringMatching(toQuoteFilePattern(app)) as unknown,
      line: findQuoteLine(app),
      statuses: Array.from({ length: REQUESTS }, () => 200),
    });
  });
});

describe.each(DOCKER_APPS)("docker stop of the $service container", (app) => {
  it("sends the snapshot taken just before and exits by itself", async () => {
    await waitUntilActive(app);
    const before = countSnapshots(app);
    await fetchInARow(toQuoteUrl(app), 1);

    const stopped = stopService(app.service);
    await hub.waitForLines((line) => isSnapshotOf(app, line), before + 1);

    expect(stopped).toEqual({ status: "exited", exitCode: app.exitOnSigterm, isOomKilled: false });
  });
});
