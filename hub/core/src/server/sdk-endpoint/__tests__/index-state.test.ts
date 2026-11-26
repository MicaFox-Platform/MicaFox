import type { Message } from "@micafox/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { keyOf, openEndpointApp, ORG_A, ORG_B, tokenOf } from "../../../../test/sdk-endpoint/endpoint-app.js";
import type { EndpointApp } from "../../../../test/sdk-endpoint/endpoint-app.js";
import { breakpointsOf, recordingModule } from "../../../../test/sdk-endpoint/recording-module.js";
import type { RecordingBehavior } from "../../../../test/sdk-endpoint/recording-module.js";
import { helloOf, openSdk } from "../../../../test/sdk-endpoint/sdk-client.js";

const TOKEN = tokenOf("a");
const apps: EndpointApp[] = [];

afterEach(async () => {
  await Promise.all(
    apps.splice(0).map(async (app) => {
      await app.close();
    }),
  );
});

const resendEvent = (overrides: { orgId?: string; environmentId?: string; type?: string; module?: string } = {}) => ({
  type: overrides.type ?? "sdk.state.resend",
  orgId: overrides.orgId ?? ORG_A,
  environmentId: overrides.environmentId ?? "production",
  actor: { userId: "system" },
  data: { module: overrides.module ?? "debugger" },
});

// An endpoint that serves `debugger`, with the behavior of its state, and a second module `metrics` nobody asks for
const open = async (behavior: RecordingBehavior = {}) => {
  const debuggerModule = recordingModule("debugger", behavior);
  const metrics = recordingModule("metrics");
  const app = await openEndpointApp({}, undefined, [debuggerModule, metrics]);
  apps.push(app);
  return { app, debuggerModule, metrics };
};

describe("sending the state after welcome", () => {
  it("sends the state of each agreed module once welcome is out", async () => {
    const { app } = await open({ state: async () => await Promise.resolve([breakpointsOf("a.1")]) });
    const client = await openSdk(app.url, TOKEN);

    await client.hello(helloOf({ modules: ["debugger"] }));

    expect(await client.messages(2)).toEqual([
      { version: 1, type: "welcome", modules: ["debugger"] },
      breakpointsOf("a.1"),
    ]);
  });

  it("asks for the state of the session's instance, and of no module it did not agree on", async () => {
    const { app, debuggerModule, metrics } = await open();
    const client = await openSdk(app.url, TOKEN);

    await client.hello(helloOf({ modules: ["debugger"], instanceId: "instance-1" }));

    expect([debuggerModule.stateAsked, metrics.stateAsked]).toEqual([
      [{ orgId: ORG_A, projectId: "project-1", environmentId: "production", instanceId: "instance-1" }],
      [],
    ]);
  });

  it("closes the session with 1011 when the state cannot be read", async () => {
    const { app } = await open({
      state: async () => {
        await Promise.resolve();
        throw new Error("connection refused");
      },
    });
    const client = await openSdk(app.url, TOKEN);

    await client.hello(helloOf({ modules: ["debugger"] }));

    expect(await client.closed).toEqual({ code: 1011 });
  });
});

describe("sending a state that cannot be written", () => {
  it("closes the session with 1011 when a message of the state is not JSON", async () => {
    const { app } = await open({
      state: async () => await Promise.resolve([{ ...breakpointsOf("a.1"), size: 1n } as unknown as Message]),
    });
    const client = await openSdk(app.url, TOKEN);

    await client.hello(helloOf({ modules: ["debugger"] }));

    expect(await client.closed).toEqual({ code: 1011 });
  });
});

describe("resending the state", () => {
  // Three instances: two of the environment, one in staging, with the modules they agreed on
  const connectThree = async (app: EndpointApp) => {
    app.keys.set(tokenOf("staging"), keyOf("staging", { environmentId: "staging" }));
    const agreed = await openSdk(app.url, TOKEN);
    await agreed.hello(helloOf({ instanceId: "agreed", modules: ["debugger"] }));
    const withoutModule = await openSdk(app.url, TOKEN);
    await withoutModule.hello(helloOf({ instanceId: "without-module", modules: ["metrics"] }));
    const elsewhere = await openSdk(app.url, tokenOf("staging"));
    await elsewhere.hello(helloOf({ instanceId: "elsewhere", modules: ["debugger"] }));
    return { agreed, withoutModule, elsewhere };
  };

  it("sends the state again to the instances of that environment that agreed on the module", async () => {
    const { app, debuggerModule } = await open({ state: async () => await Promise.resolve([breakpointsOf("a.1")]) });
    const { agreed } = await connectThree(app);
    debuggerModule.stateAsked.length = 0;

    app.bus.publish(resendEvent());

    expect([debuggerModule.stateAsked.map(({ instanceId }) => instanceId), (await agreed.messages(3)).at(-1)]).toEqual([
      ["agreed"],
      breakpointsOf("a.1"),
    ]);
  });

  it("does not resend for another organization, another event type or a module nobody serves", async () => {
    const { app, debuggerModule } = await open();
    await connectThree(app);
    debuggerModule.stateAsked.length = 0;

    app.bus.publish(resendEvent({ orgId: ORG_B }));
    app.bus.publish(resendEvent({ type: "debugger.breakpoint.changed" }));
    app.bus.publish(resendEvent({ module: "nobody" }));

    expect(debuggerModule.stateAsked).toEqual([]);
  });

  it("ignores a resend event without a module, or with one that is not a name", async () => {
    const { app, debuggerModule } = await open();
    await connectThree(app);
    debuggerModule.stateAsked.length = 0;

    app.bus.publish({ ...resendEvent(), data: {} });
    app.bus.publish({ ...resendEvent(), data: { module: 7 } });
    app.bus.publish({
      type: "sdk.state.resend",
      orgId: ORG_A,
      actor: { userId: "system" },
      data: { module: "debugger" },
    });

    expect(debuggerModule.stateAsked).toEqual([]);
  });

  it("reads a state again when a resend overtook it, and sends only the newer one", async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The state per read: the first is the welcome's, the second is held while a resend comes in
    const states = [breakpointsOf("first.1"), breakpointsOf("old.1"), breakpointsOf("new.1")];
    let reads = 0;
    const { app } = await open({
      state: async () => {
        reads += 1;
        if (reads === 2) {
          await held;
        }
        return [states[reads - 1] ?? breakpointsOf("unexpected")];
      },
    });
    const client = await openSdk(app.url, TOKEN);
    await client.hello(helloOf({ modules: ["debugger"] }));
    await client.messages(2);

    app.bus.publish(resendEvent());
    app.bus.publish(resendEvent());
    release();

    expect((await client.messages(3)).slice(1)).toEqual([breakpointsOf("first.1"), breakpointsOf("new.1")]);
  });

  it("reads once more, not once per resend, for a burst that came while a state was being read", async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    const { app, debuggerModule } = await open({
      state: async () => {
        reads += 1;
        if (reads === 2) {
          await held;
        }
        return [breakpointsOf(`read-${String(reads)}.1`)];
      },
    });
    const client = await openSdk(app.url, TOKEN);
    await client.hello(helloOf({ modules: ["debugger"] }));
    await client.messages(2);

    app.bus.publish(resendEvent());
    app.bus.publish(resendEvent());
    app.bus.publish(resendEvent());
    app.bus.publish(resendEvent());
    release();
    const [, , last] = await client.messages(3);

    expect([debuggerModule.stateAsked.length, last]).toEqual([3, breakpointsOf("read-3.1")]);
  });
});
