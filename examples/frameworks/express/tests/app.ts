// The Express app of this example, described for the kit's helpers: it runs its source under plain `node`, which loads
// the SDK's built `dist/`.

import { LISTENING, type QuoteApp } from "@micafox/testkit";
import path from "node:path";

/** Express 5 in plain CommonJS JavaScript. */
export const EXPRESS_APP: QuoteApp = {
  name: "Express",
  directory: path.join(import.meta.dirname, ".."),
  args: ["src/server.js"],
  quoteSource: "src/quote.js",
  ready: LISTENING,
  exitOnSigterm: 0,
  stopMarker: "micafox stopped",
};
