import { sendProblem } from "../app/index.js";
import type { HubApp } from "../app/index.js";

/** Where the hub is in its life; only `ready` serves anything but `/healthz`. */
export type Phase = "starting" | "ready" | "stopping";

/** Adds `/healthz`, `/readyz` and the gate that answers 503 `not-ready` on every other route until the hub is ready. */
export const registerHealth = (app: HubApp, getPhase: () => Phase): void => {
  app.addHook("onRequest", async (request, reply) => {
    if (getPhase() === "ready" || request.url.split("?")[0] === "/healthz") {
      return;
    }
    // A stopping hub asks the client to open its next connection elsewhere
    await sendProblem(reply.header("connection", "close"), "not-ready");
  });

  // A request that was running when the stop began ends its keep-alive connection, so the drain need not wait for it
  app.addHook("onSend", async (_request, reply, payload) => {
    if (getPhase() === "stopping") {
      void reply.header("connection", "close");
    }
    return payload;
  });

  app.get("/healthz", () => ({ status: "ok" }));
  app.get("/readyz", () => ({ status: "ready" }));
};
