// The run example of docs/api/sdk/debugger.md, word for word below this comment: debugger.test.ts fails when the two
// differ, and `pnpm typecheck` compiles it through the package's own exports.

import { micafox } from "@micafox/sdk";

micafox.run(); // hub URL, token and service from MICAFOX_HUB_URL, MICAFOX_TOKEN and MICAFOX_SERVICE
