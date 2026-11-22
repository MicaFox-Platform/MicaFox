import pino from "pino";

import { captureLog } from "./log-capture.js";
import type { LogCapture } from "./log-capture.js";
import { createApp } from "../../src/server/app/index.js";
import type { AppOptions, HubApp } from "../../src/server/app/index.js";

/** An app as the hub creates it, over HTTPS unless `publicUrl` says otherwise, with its log captured. */
export const createTestApp = (options: Partial<Omit<AppOptions, "logger">> = {}): { app: HubApp; log: LogCapture } => {
  const log = captureLog();
  const app = createApp({
    logger: pino({}, log.stream),
    trustProxy: false,
    publicUrl: "https://hub.example.com",
    version: "1.2.3",
    ...options,
  });
  return { app, log };
};
