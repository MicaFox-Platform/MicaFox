import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { captureLog } from "../../../../test/server/log-capture.js";
import { createLogger } from "../index.js";
import type { LoggerOptions } from "../index.js";

const create = (
  overrides: Partial<LoggerOptions> = {},
): { logger: ReturnType<typeof createLogger>; text: () => string } => {
  const { stream, text } = captureLog();
  const logger = createLogger({ level: "info", format: "json", stream, timers: globalThis, ...overrides });
  return { logger, text };
};

describe("createLogger", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes JSON lines with the level as a word", () => {
    const { logger, text } = create();

    logger.log.info({ reqId: "r1" }, "hello");

    expect(JSON.parse(text())).toMatchObject({ level: "info", msg: "hello", reqId: "r1" });
  });

  it.each([
    ["warn", "info", false],
    ["debug", "debug", true],
    ["error", "warn", false],
  ] as const)("at level %s, a %s line is written: %s", (level, called, isWritten) => {
    const { logger, text } = create({ level });

    logger.log[called]("line");

    expect(text() !== "").toBe(isWritten);
  });

  it("writes pretty output when asked", () => {
    const { logger, text } = create({ format: "pretty" });

    logger.log.info({ reqId: "r1" }, "hello");

    expect(text()).toMatch(/INFO.*hello/);
    expect(text()).not.toMatch(/^\{/);
  });

  it("redacts secrets in the fields of a line, also on a child logger", () => {
    const { logger, text } = create();

    logger.log
      .child({ reqId: "r1" })
      .info({ req: { headers: { authorization: "Bearer a", cookie: "sid=1" }, password: "pw" } }, "x");

    expect(text()).not.toMatch(/Bearer a|sid=1|"pw"/);
    expect(JSON.parse(text())).toMatchObject({
      reqId: "r1",
      req: { headers: { authorization: "[redacted]", cookie: "[redacted]" }, password: "[redacted]" },
    });
  });

  it("redacts secrets in pretty output too", () => {
    const { logger, text } = create({ format: "pretty" });

    logger.log.info({ headers: { authorization: "Bearer a" } }, "x");

    expect(text()).toContain("[redacted]");
    expect(text()).not.toContain("Bearer a");
  });

  it("redacts secrets in the fields an error carries", () => {
    const { logger, text } = create();
    const error = Object.assign(new Error("request failed"), { config: { headers: { authorization: "Bearer a" } } });

    logger.log.error({ err: error }, "x");

    expect(text()).not.toContain("Bearer a");
    expect(JSON.parse(text())).toMatchObject({
      err: { message: expect.stringContaining("request failed") as unknown },
    });
  });

  it("collapses repeated warnings through warnCollapsed", () => {
    const { logger, text } = create();

    logger.warnCollapsed("k", {}, "rejected");
    logger.warnCollapsed("k", {}, "rejected");
    logger.flush();

    expect(text().trim().split("\n")).toHaveLength(2);
    expect(text()).toContain('"count":1');
  });

  it("survives an error on its stream", () => {
    const { stream, text } = captureLog();
    createLogger({ level: "info", format: "json", stream, timers: globalThis });

    expect(() => stream.emit("error", new Error("EPIPE"))).not.toThrow();
    expect(text()).toBe("");
  });
});
