// A NestJS app compiled by the Nest CLI (tsc) to CommonJS with .map files, run with plain `node`: `require()` loads the
// SDK's `dist/cjs` build. The SDK starts before NestFactory.create() and is configured by the MICAFOX_* environment
// variables.

import { micafox } from "@micafox/sdk";
import { NestFactory } from "@nestjs/core";

import { AppModule } from "./app.module.js";

// A test choice, not a recommendation: a restarted hub sees the app again within a second
micafox.configure({ hubConnector: { reconnect: { minDelayMs: 100, maxDelayMs: 1000 } } });
micafox.run();

const main = async (): Promise<void> => {
  const app = await NestFactory.create(AppModule, { logger: ["error", "warn"] });
  // close() stops the server and runs AppModule.onApplicationShutdown(); the process then ends with code 0 once nothing
  // is left. Not enableShutdownHooks(): it ends the process by re-sending the signal, which a container's PID 1 ignores
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      app.close().catch((error: unknown) => {
        console.error("failed to shut down:", error);
        process.exitCode = 1;
      });
    });
  }
  // An empty HOST counts as unset: listen() would take "" as every interface
  const host = process.env.HOST ?? "";
  await app.listen(Number(process.env.PORT ?? "0"), host === "" ? "127.0.0.1" : host);
  const { port } = new URL(await app.getUrl());
  console.log(`listening on port ${port}`);
};

void main();
