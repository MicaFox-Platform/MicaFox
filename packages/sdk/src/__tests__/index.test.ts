import { describe, expect, it } from "vitest";

import * as sdk from "../index.js";

describe("sdk", () => {
  it("exports HubConnector and micafox as its only runtime values", () => {
    expect(Object.keys(sdk).sort()).toEqual(["HubConnector", "micafox"]);
  });
});
