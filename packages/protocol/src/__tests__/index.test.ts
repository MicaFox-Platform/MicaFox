import { describe, expect, it } from "vitest";

import * as protocol from "../index.js";

describe("protocol", () => {
  it("exports no runtime values besides the wire constants", () => {
    expect(Object.keys(protocol).sort()).toEqual(["CLOSE_CODES", "PROTOCOL_VERSION"]);
  });

  it("keeps the wire constants that hubs and connectors rely on", () => {
    expect(protocol.PROTOCOL_VERSION).toBe(1);
    expect(protocol.CLOSE_CODES).toEqual({ protocolError: 4400, incompatibleVersion: 4426 });
  });
});
