export { checkHubTarget, type HubTarget } from "./connection/index.js";
export { HubConnector } from "./hub-connector/index.js";
// The option helpers follow ADR 0003 for the debugger's options too; the debugger checks the hub target with the
// connector's own resolution, so the two never disagree on whether there is one
export {
  isRecord,
  LOGGER_KEY,
  readEnv,
  readField,
  resolveOptions,
  type HubConnectorOptions,
  type Warn,
} from "./options/index.js";
