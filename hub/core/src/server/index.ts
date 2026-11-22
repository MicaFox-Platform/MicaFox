// The server entry ("."): docs/architecture/hub/overview.md#packages
export { ConfigError } from "./config/index.js";
export { createHub, runHub } from "./lifecycle/index.js";
export type { Hub, HubOptions, RunHubOptions, RunHubProcess } from "./lifecycle/index.js";
