import { E2E_TEST_TIMEOUT_MS, useProcesses } from "@micafox/testkit";
import { describe, expect, it } from "vitest";

import { startApp, startHub, toAppUrl, waitForLog } from "./harness.js";

describe("app startup", { timeout: E2E_TEST_TIMEOUT_MS }, () => {
  useProcesses();

  it("writes the SDK's info lines through the app's pino when MICAFOX_LOG_LEVEL is info", async () => {
    const hub = await startHub({ breakpoints: [] });
    const app = await startApp({ hubPort: hub.port, logLevel: "info" });

    const line = await waitForLog(app.run, "[micafox] debugger: started with");

    expect(JSON.parse(line)).toEqual(expect.objectContaining({ level: 30 }));
  });

  it("sends no hello and still serves HTTP when MICAFOX_ENABLED is false", async () => {
    const hub = await startHub({ breakpoints: [] });
    const app = await startApp({ hubPort: hub.port, enabled: "false", logLevel: "info" });
    // run() logs this and returns; nothing connects afterwards
    await waitForLog(app.run, "[micafox] debugger: turned off");

    const response = await fetch(toAppUrl(app.port, "/health"));

    expect({ status: response.status, messages: hub.run.messages() }).toEqual({ status: 200, messages: [] });
  });

  it("logs the SDK's error and still serves HTTP when MICAFOX_HUB_URL is not set", async () => {
    const app = await startApp();
    await waitForLog(app.run, "[micafox] debugger: no hub URL");

    const response = await fetch(toAppUrl(app.port, "/health"));
    const body: unknown = await response.json();

    expect({ status: response.status, body }).toEqual({ status: 200, body: { ok: true } });
  });

  it("exits with code 1 when its port is taken, though the debugger is connected to a hub", async () => {
    const hub = await startHub({ breakpoints: [] });

    // With a hub URL, so the exit also proves the running debugger does not keep the process alive
    const started = startApp({ port: hub.port, hubPort: hub.port });

    await expect(started).rejects.toThrow(/app exited \(code 1\)[\s\S]*failed to start:/);
  });
});
