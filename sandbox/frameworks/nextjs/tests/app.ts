// The Next.js app of this example, described for the kit's helpers: `next start` serves the output of `next build`
// and loads the SDK's built `dist/`.

import { type QuoteApp } from "@micafox/testkit";
import path from "node:path";

/** Next.js built by `next build` and served by `next start` on the Node.js runtime. */
export const NEXTJS_APP: QuoteApp = {
  name: "Next.js",
  directory: path.join(import.meta.dirname, ".."),
  // `next start` serves from its own process, so no worker process can be orphaned. Port 0 picks a free port, which
  // Next.js prints on its `- Local:` line, before `Ready`
  args: ["node_modules/next/dist/bin/next", "start", "src", "--hostname", "127.0.0.1", "--port", "0"],
  quoteSource: "src/app/quote/route.ts",
  ready: { ready: /^✓ Ready in /, port: /^- Local:\s+http:\/\/127\.0\.0\.1:(\d+)$/ },
  // `next start` shuts down gracefully on SIGTERM and exits with 128 + 15
  exitOnSigterm: 143,
  // Next.js exits by itself, so instrumentation-node.ts only starts stop() and does not wait for it
  stopMarker: "micafox stopping",
  env: new Map([
    // Vitest sets NODE_ENV=test, which `next start` keeps
    ["NODE_ENV", "production"],
    ["NEXT_TELEMETRY_DISABLED", "1"],
  ]),
};
