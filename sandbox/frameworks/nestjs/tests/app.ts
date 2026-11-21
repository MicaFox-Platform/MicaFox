// The NestJS app of this example, described for the kit's helpers: it runs its built output under plain `node`, which
// loads the SDK's built `dist/`.

import { LISTENING, type QuoteApp } from "@micafox/testkit";
import path from "node:path";

/** NestJS compiled by the Nest CLI; on SIGTERM main.ts closes Nest, which runs its shutdown hooks, and it exits with 0. */
export const NESTJS_APP: QuoteApp = {
  name: "NestJS",
  directory: path.join(import.meta.dirname, ".."),
  args: ["dist/main.js"],
  quoteSource: "src/quote.controller.ts",
  ready: LISTENING,
  exitOnSigterm: 0,
  stopMarker: "micafox stopped",
};
