import { describe, expect, it } from "vitest";

import { toValidationDetails } from "../validation-errors.js";

describe("toValidationDetails", () => {
  it("escapes a missing property's name as a JSON Pointer token", () => {
    const details = toValidationDetails(
      [
        {
          keyword: "required",
          instancePath: "/labels",
          schemaPath: "#/properties/labels/required",
          params: { missingProperty: "app/tier~1" },
          message: "must have required property 'app/tier~1'",
        },
      ],
      "body",
    );

    expect(details.errors).toEqual([
      { path: "/labels/app~1tier~01", in: "body", message: "must have required property 'app/tier~1'" },
    ]);
  });

  it("names the part of the request in the detail when the whole part failed", () => {
    const details = toValidationDetails(
      [
        {
          keyword: "type",
          instancePath: "",
          schemaPath: "#/type",
          params: { type: "object" },
          message: "must be object",
        },
      ],
      undefined,
    );

    expect(details).toEqual({
      detail: "body: must be object",
      errors: [{ path: "", in: "body", message: "must be object" }],
    });
  });

  it("reports headers by their own name", () => {
    const details = toValidationDetails(
      [{ keyword: "type", instancePath: "/x-count", schemaPath: "#/type", params: {}, message: "must be integer" }],
      "headers",
    );

    expect(details.errors).toEqual([{ path: "/x-count", in: "headers", message: "must be integer" }]);
  });

  it("gives a generic message when the validator gave none", () => {
    const details = toValidationDetails(
      [{ keyword: "custom", instancePath: "/name", schemaPath: "#", params: {} }],
      "body",
    );

    expect(details.detail).toBe("name: is not valid");
  });
});
