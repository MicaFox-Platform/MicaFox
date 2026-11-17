import { PROTOCOL_VERSION } from "@micafox/protocol";

import { parseJson } from "./inbound.js";
import { agreeOnModules, type ModuleAgreement } from "./modules.js";

/** The result of `checkFirstFrame()`; `reason` never quotes the frame, which the hub controls. */
export type FirstFrameCheck = ({ ok: true } & ModuleAgreement) | { ok: false; reason: string };

const describeVersion = (version: unknown): string =>
  typeof version === "number" ? `protocol version ${String(version)}` : "no valid protocol version";

/**
 * Checks the first frame from the hub, which must be a `welcome` of the session's version with a `modules` array
 * (ADR 0009, ADR 0016, ADR 0017), and agrees on the modules with `helloModules`; `text` is `undefined` for a binary
 * frame.
 */
export const checkFirstFrame = (text: string | undefined, helloModules: readonly string[]): FirstFrameCheck => {
  if (text === undefined) {
    return { ok: false, reason: "the hub sent a binary frame before welcome" };
  }

  const message = parseJson(text);
  if (typeof message !== "object" || message === null || Reflect.get(message, "type") !== "welcome") {
    return { ok: false, reason: "the hub sent a frame other than welcome first" };
  }

  const version: unknown = Reflect.get(message, "version");
  if (version !== PROTOCOL_VERSION) {
    return {
      ok: false,
      reason: `the hub's welcome has ${describeVersion(version)}; the SDK speaks ${String(PROTOCOL_VERSION)}`,
    };
  }

  const modules: unknown = Reflect.get(message, "modules");
  if (!Array.isArray(modules)) {
    return { ok: false, reason: "the hub's welcome has no modules array" };
  }

  return { ok: true, ...agreeOnModules(helloModules, modules) };
};
