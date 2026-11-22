import { describe, expect, it } from "vitest";

import { captureLog } from "../../../../test/server/log-capture.js";
import { createApp } from "../index.js";
import type { AppOptions } from "../index.js";

const ipSeenBy = async (trustProxy: AppOptions["trustProxy"]): Promise<string> => {
  const app = createApp({ logger: (await import("pino")).default({}, captureLog().stream), trustProxy });
  app.get("/ip", (request) => request.ip);
  const response = await app.inject({
    url: "/ip",
    remoteAddress: "10.0.0.1",
    headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.2" },
  });
  await app.close();
  return response.body;
};

describe("createApp trust proxy", () => {
  it("believes no forwarded header by default", async () => {
    await expect(ipSeenBy(false)).resolves.toBe("10.0.0.1");
  });

  it("believes every proxy when true", async () => {
    await expect(ipSeenBy(true)).resolves.toBe("203.0.113.7");
  });

  it("believes the given number of hops", async () => {
    await expect(ipSeenBy(1)).resolves.toBe("10.0.0.2");
    await expect(ipSeenBy(2)).resolves.toBe("203.0.113.7");
  });

  it("believes proxies listed by address or CIDR", async () => {
    await expect(ipSeenBy(["10.0.0.0/8"])).resolves.toBe("203.0.113.7");
    await expect(ipSeenBy(["192.168.0.1"])).resolves.toBe("10.0.0.1");
  });
});
