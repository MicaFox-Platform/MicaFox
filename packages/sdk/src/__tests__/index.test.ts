import { describe, expect, it } from "vitest";

import * as sdk from "../index.js";

describe("sdk", () => {
  it("exports HubConnector as its only runtime value", () => {
    expect(Object.keys(sdk)).toEqual(["HubConnector"]);
  });
});
