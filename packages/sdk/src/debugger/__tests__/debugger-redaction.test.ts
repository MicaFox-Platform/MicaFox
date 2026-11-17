import { describe, expect, it } from "vitest";

import { createDebugger, envOf, FakeConnector } from "../../../test/debugger/fakes.js";

describe("Debugger.run() redaction rules", () => {
  it("logs the 15 built-in rules in the started line when nothing is added", () => {
    const { micafox, messagesAt } = createDebugger();
    micafox.configure({ connector: new FakeConnector(), logLevel: "info" });

    micafox.run();

    expect(messagesAt("info")).toEqual(["started with a custom connector and 15 redaction rules"]);
  });

  it("adds the names of the redact option and of MICAFOX_REDACT to the count", () => {
    const { micafox, messagesAt } = createDebugger({ env: envOf(["MICAFOX_REDACT", "ssn, clientKey"]) });
    micafox.configure({ connector: new FakeConnector(), logLevel: "info", redact: ["iban"] });

    micafox.run();

    expect(messagesAt("info")).toEqual(["started with a custom connector and 18 redaction rules"]);
  });

  it("skips an entry that is empty after normalizing with a warning at run(), not at configure()", () => {
    const { micafox, messagesAt } = createDebugger({ env: envOf(["MICAFOX_REDACT", "ssn,,"]) });
    micafox.configure({ connector: new FakeConnector(), logLevel: "info", redact: ["_"] });
    const atConfigure = messagesAt("warn");

    micafox.run();

    expect({ atConfigure, atRun: messagesAt("warn"), info: messagesAt("info") }).toEqual({
      atConfigure: [],
      atRun: [
        "redact has an entry that is not a usable name; it is skipped",
        "MICAFOX_REDACT has an entry that is not a usable name; it is skipped",
        "MICAFOX_REDACT has an entry that is not a usable name; it is skipped",
      ],
      info: ["started with a custom connector and 16 redaction rules"],
    });
  });

  it("resolves the rules again at the next run() from the environment of that moment", async () => {
    const env: Record<string, string | undefined> = {};
    const { micafox, messagesAt } = createDebugger({ env });
    micafox.configure({ connector: new FakeConnector(), logLevel: "info" });

    micafox.run();
    await micafox.stop();
    env.MICAFOX_REDACT = "iban";
    micafox.run();

    expect(messagesAt("info")).toEqual([
      "started with a custom connector and 15 redaction rules",
      "stopped",
      "started with a custom connector and 16 redaction rules",
    ]);
  });

  it("still starts and keeps the built-in rules when redact is not an array", () => {
    const { micafox, messagesAt } = createDebugger();
    micafox.configure({ connector: new FakeConnector(), logLevel: "info", redact: "iban" as unknown as string[] });

    micafox.run();

    expect({ warn: messagesAt("warn"), info: messagesAt("info") }).toEqual({
      warn: ["redact must be an array of names; it is ignored"],
      info: ["started with a custom connector and 15 redaction rules"],
    });
  });
});
