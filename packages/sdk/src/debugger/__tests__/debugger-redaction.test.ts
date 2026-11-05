import { describe, expect, it } from "vitest";

import { createDebugger, envOf, FakeConnector } from "../../../test/debugger/fakes.js";

describe("Debugger.run() redaction rules", () => {
  it("logs the 15 built-in rules in the started line when nothing is added", () => {
    const { probex, messagesAt } = createDebugger();
    probex.configure({ connector: new FakeConnector(), logLevel: "info" });

    probex.run();

    expect(messagesAt("info")).toEqual(["started with a custom connector and 15 redaction rules"]);
  });

  it("adds the names of the redact option and of PROBEX_REDACT to the count", () => {
    const { probex, messagesAt } = createDebugger({ env: envOf(["PROBEX_REDACT", "ssn, clientKey"]) });
    probex.configure({ connector: new FakeConnector(), logLevel: "info", redact: ["iban"] });

    probex.run();

    expect(messagesAt("info")).toEqual(["started with a custom connector and 18 redaction rules"]);
  });

  it("skips an entry that is empty after normalizing with a warning at run(), not at configure()", () => {
    const { probex, messagesAt } = createDebugger({ env: envOf(["PROBEX_REDACT", "ssn,,"]) });
    probex.configure({ connector: new FakeConnector(), logLevel: "info", redact: ["_"] });
    const atConfigure = messagesAt("warn");

    probex.run();

    expect({ atConfigure, atRun: messagesAt("warn"), info: messagesAt("info") }).toEqual({
      atConfigure: [],
      atRun: [
        "redact has an entry that is not a usable name; it is skipped",
        "PROBEX_REDACT has an entry that is not a usable name; it is skipped",
        "PROBEX_REDACT has an entry that is not a usable name; it is skipped",
      ],
      info: ["started with a custom connector and 16 redaction rules"],
    });
  });

  it("resolves the rules again at the next run() from the environment of that moment", async () => {
    const env: Record<string, string | undefined> = {};
    const { probex, messagesAt } = createDebugger({ env });
    probex.configure({ connector: new FakeConnector(), logLevel: "info" });

    probex.run();
    await probex.stop();
    env.PROBEX_REDACT = "iban";
    probex.run();

    expect(messagesAt("info")).toEqual([
      "started with a custom connector and 15 redaction rules",
      "stopped",
      "started with a custom connector and 16 redaction rules",
    ]);
  });

  it("still starts and keeps the built-in rules when redact is not an array", () => {
    const { probex, messagesAt } = createDebugger();
    probex.configure({ connector: new FakeConnector(), logLevel: "info", redact: "iban" as unknown as string[] });

    probex.run();

    expect({ warn: messagesAt("warn"), info: messagesAt("info") }).toEqual({
      warn: ["redact must be an array of names; it is ignored"],
      info: ["started with a custom connector and 15 redaction rules"],
    });
  });
});
