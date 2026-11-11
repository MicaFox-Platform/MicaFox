import { PROTOCOL_VERSION, type Message } from "@micafox/protocol";
import { describe, expect, it } from "vitest";

import { toActiveStatuses } from "../debugger-stand-in.js";

// What the connector hands over from a misbehaving hub: it checks only version and type, so the rest arrives as sent
const breakpointsMessage = (breakpoints: unknown): Message =>
  JSON.parse(JSON.stringify({ version: PROTOCOL_VERSION, type: "breakpoints", breakpoints })) as Message;

describe("toActiveStatuses", () => {
  it("returns one active status per breakpoint", () => {
    const message = breakpointsMessage([
      { id: "bp-1", file: "src/a.ts", line: 1 },
      { id: "bp-2", file: "src/b.ts", line: 2 },
    ]);

    const statuses = toActiveStatuses(message);

    expect(statuses).toEqual([
      { version: 1, type: "breakpointStatus", breakpointId: "bp-1", status: "active" },
      { version: 1, type: "breakpointStatus", breakpointId: "bp-2", status: "active" },
    ]);
  });

  it("skips entries without a string id", () => {
    const message = breakpointsMessage([{ id: 7 }, "bp-1", null, { id: "bp-2" }]);

    const statuses = toActiveStatuses(message);

    expect(statuses.map((status) => status.breakpointId)).toEqual(["bp-2"]);
  });

  it("returns no statuses when breakpoints is not a list", () => {
    const message = breakpointsMessage({ id: "bp-1" });

    const statuses = toActiveStatuses(message);

    expect(statuses).toEqual([]);
  });

  it("returns no statuses for a message other than breakpoints", () => {
    const message: Message = { version: PROTOCOL_VERSION, type: "welcome" };

    const statuses = toActiveStatuses(message);

    expect(statuses).toEqual([]);
  });
});
