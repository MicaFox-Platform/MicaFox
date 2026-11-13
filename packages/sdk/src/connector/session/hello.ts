import { PROTOCOL_VERSION, type Hello } from "@micafox/protocol";
import { hostname } from "node:os";

import { SDK_VERSION } from "./version.js";
import type { Labels } from "../options/index.js";

/** What a `hello` says about the app instance besides the fixed fields. */
export interface HelloFields {
  instanceId: string;
  service: string | undefined;
  labels: Labels;
  /** The modules this instance runs. */
  modules: readonly string[];
}

const SDK_NAME = "@micafox/sdk";

const readHostname = (): string => {
  try {
    return hostname();
  } catch {
    // libuv reports a failed gethostname as an exception; a hello without a name still identifies the instance
    return "unknown";
  }
};

/** Builds the `hello` the connector sends as the first frame of every connection (ADR 0009). */
export const buildHello = ({ instanceId, service, labels, modules }: HelloFields): Hello => ({
  version: PROTOCOL_VERSION,
  type: "hello",
  instanceId,
  ...(service === undefined ? {} : { service }),
  labels: { ...labels },
  hostname: readHostname(),
  pid: process.pid,
  sdk: { name: SDK_NAME, version: SDK_VERSION },
  runtime: { name: "node", version: process.versions.node },
  modules: [...modules],
});
