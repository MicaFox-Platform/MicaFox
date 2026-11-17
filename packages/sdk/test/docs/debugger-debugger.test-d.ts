// The Debugger example of docs/api/sdk/debugger.md, word for word below this comment: debugger.test.ts fails when
// the two differ, and `pnpm typecheck` compiles it through the package's own exports.
/* eslint-disable @typescript-eslint/no-unused-vars -- the example only has to compile */

import { micafox, type Debugger } from "@micafox/sdk";

const debuggerForTests: Debugger = micafox;
