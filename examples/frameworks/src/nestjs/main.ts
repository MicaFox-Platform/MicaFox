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
  // On SIGTERM Nest closes the server, runs AppModule.onApplicationShutdown() and then ends by the same signal
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? "0"), "127.0.0.1");
  const { port } = new URL(await app.getUrl());
  console.log(`listening on port ${port}`);
};

void main();
