// The app's only module. Its shutdown hook stops the SDK, so stop() sends the buffered snapshots when Nest shuts down.

import { micafox } from "@micafox/sdk";
import { Module, type OnApplicationShutdown } from "@nestjs/common";

import { QuoteController } from "./quote.controller.js";

@Module({ controllers: [QuoteController] })
export class AppModule implements OnApplicationShutdown {
  // Nest calls it after the HTTP server has closed, when main.ts closes the app on SIGTERM
  async onApplicationShutdown(): Promise<void> {
    await micafox.stop();
    console.log("micafox stopped");
  }
}
