import { assertType, expectTypeOf } from "vitest";

import type { DebuggerOptions } from "../index.js";

expectTypeOf<DebuggerOptions["redact"]>().toEqualTypeOf<string[] | undefined>();

// @ts-expect-error redact takes an array of names, not one comma-separated string
assertType<DebuggerOptions>({ redact: "iban,ssn" });
