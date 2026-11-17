import { describe, expect, it } from "vitest";

import {
  createDebugger,
  createRecordingLogger,
  envOf,
  FakeConnector,
  type LoggedLine,
} from "../../../test/debugger/fakes.js";
import type { DebuggerOptions } from "../index.js";

// Options from a plain JavaScript app, where a field may be a getter that throws
const withThrowingUrl = (fields: DebuggerOptions): DebuggerOptions =>
  Object.defineProperty({ ...fields }, "url", {
    enumerable: true,
    get: () => {
      throw new Error("url getter failed");
    },
  });

describe("Debugger.configure() while not running", () => {
  it("merges the fields of several calls", () => {
    const connector = new FakeConnector();
    const { micafox, messagesAt } = createDebugger();
    micafox.configure({ connector });
    micafox.configure({ logLevel: "info" });

    micafox.run();

    expect(messagesAt("info")).toEqual(["started with a custom connector and 15 redaction rules"]);
  });

  it("replaces an earlier object field whole", () => {
    const first = new FakeConnector();
    const second = new FakeConnector();
    const { micafox } = createDebugger();
    micafox.configure({ connector: first });
    micafox.configure({ connector: second });

    micafox.run();

    expect([first.connectCount, second.connectCount]).toEqual([0, 1]);
  });

  it("ignores a field set to undefined", () => {
    const connector = new FakeConnector();
    const { micafox } = createDebugger();
    micafox.configure({ connector });
    // TypeScript with exactOptionalPropertyTypes rejects this; plain JavaScript, and spreads of optional fields, do not
    const unset: { connector?: FakeConnector | undefined } = { connector: undefined };
    micafox.configure(unset as DebuggerOptions);

    micafox.run();

    expect(connector.connectCount).toBe(1);
  });

  it("warns and changes nothing when the options are not an object", () => {
    const connector = new FakeConnector();
    const { micafox, messagesAt } = createDebugger();
    micafox.configure({ connector });

    micafox.configure("enabled=false" as DebuggerOptions);
    micafox.run();

    expect({ warnings: messagesAt("warn"), connects: connector.connectCount }).toEqual({
      warnings: ["options must be an object; nothing changed"],
      connects: 1,
    });
  });

  it("skips a field whose getter throws with a warning and keeps the others", () => {
    const connector = new FakeConnector();
    const { micafox, messagesAt } = createDebugger();

    micafox.configure(withThrowingUrl({ connector }));
    micafox.run();

    expect({ warnings: messagesAt("warn"), connects: connector.connectCount }).toEqual({
      warnings: ["url could not be read; it is ignored"],
      connects: 1,
    });
  });
});

describe("Debugger logger before run()", () => {
  it("writes to the console at warn when MICAFOX_LOG_LEVEL is unset", () => {
    const { micafox, lines } = createDebugger();

    micafox.configure(42 as DebuggerOptions);

    expect(lines).toEqual([{ level: "warn", message: "options must be an object; nothing changed" }]);
  });

  it("writes to the console at MICAFOX_LOG_LEVEL", () => {
    const { micafox, lines } = createDebugger({ env: envOf(["MICAFOX_LOG_LEVEL", "error"]) });

    micafox.configure(42 as DebuggerOptions);

    expect(lines).toEqual([]);
  });

  it("sends the warnings of a configure() call to the logger set in that call", () => {
    const appLines: LoggedLine[] = [];
    const { micafox, lines } = createDebugger();

    micafox.configure(withThrowingUrl({ logger: createRecordingLogger(appLines) }));

    expect({ app: appLines, console: lines }).toEqual({
      app: [{ level: "warn", message: "url could not be read; it is ignored" }],
      console: [],
    });
  });

  it("applies the logLevel set in a configure() call to that call's warnings", () => {
    const { micafox, lines } = createDebugger();

    micafox.configure(withThrowingUrl({ logLevel: "error" }));

    expect(lines).toEqual([]);
  });
});

describe("Debugger.configure() while running or stopping", () => {
  it("warns and changes nothing while running", async () => {
    const first = new FakeConnector();
    const second = new FakeConnector();
    const { micafox, messagesAt } = createDebugger();
    micafox.configure({ connector: first });
    micafox.run();

    micafox.configure({ connector: second });
    await micafox.stop();
    micafox.run();

    expect({ warnings: messagesAt("warn"), connects: [first.connectCount, second.connectCount] }).toEqual({
      warnings: ["configure() while the debugger is running changes nothing; call it before run()"],
      connects: [2, 0],
    });
  });

  it("warns and changes nothing while stopping", async () => {
    const first = new FakeConnector();
    const second = new FakeConnector();
    const { micafox, messagesAt } = createDebugger();
    micafox.configure({ connector: first });
    micafox.run();
    first.onUnsubscribe = () => {
      micafox.configure({ connector: second });
    };

    await micafox.stop();
    first.onUnsubscribe = () => undefined;
    micafox.run();

    expect({ warnings: messagesAt("warn"), connects: [first.connectCount, second.connectCount] }).toEqual({
      warnings: [
        "configure() while the debugger is stopping changes nothing; call it before run()",
        "configure() while the debugger is stopping changes nothing; call it before run()",
      ],
      connects: [2, 0],
    });
  });
});
