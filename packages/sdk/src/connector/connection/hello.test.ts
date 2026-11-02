import { hostname } from "node:os";
import { describe, expect, it, vi } from "vitest";

import { buildHello } from "./hello.js";
import { SDK_VERSION } from "./version.js";

// os is the boundary: the real hostname() in the other tests, a failing one where a test asks for it
vi.mock(import("node:os"), async (importOriginal) => {
  const os = await importOriginal();
  return { ...os, hostname: vi.fn(os.hostname) };
});

const INSTANCE_ID = "6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b";

describe("buildHello", () => {
  it("describes the instance, the SDK and the runtime", () => {
    const hello = buildHello({ instanceId: INSTANCE_ID, service: "checkout", labels: { region: "eu" } });

    expect(hello).toEqual({
      version: 1,
      type: "hello",
      instanceId: INSTANCE_ID,
      service: "checkout",
      labels: { region: "eu" },
      hostname: hostname(),
      pid: process.pid,
      sdk: { name: "@probex-platform/sdk", version: SDK_VERSION },
      runtime: { name: "node", version: process.versions.node },
    });
  });

  it("leaves service out when it is not set", () => {
    const hello = buildHello({ instanceId: INSTANCE_ID, service: undefined, labels: {} });

    expect(hello).not.toHaveProperty("service");
  });

  it("sends unknown as the hostname when the system cannot tell it", () => {
    vi.mocked(hostname).mockImplementationOnce(() => {
      throw new Error("uv_os_gethostname returned ENOSYS");
    });

    const hello = buildHello({ instanceId: INSTANCE_ID, service: undefined, labels: {} });

    expect(hello.hostname).toBe("unknown");
  });
});
