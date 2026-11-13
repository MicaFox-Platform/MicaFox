// The end-to-end test kit of the examples: they start their apps and the fake hub as real child processes and wait
// on what each prints. The fake hub itself runs from fake-hub/main.ts, started by startHub() or the `start:hub` script.

export { ChildProcessRun, parseJsonLine, readType, type Exit } from "./child-process-run.js";
export { readStatus, startHub, waitForStatus, type HubOptions } from "./hub.js";
export { findMarkerLine } from "./markers.js";
export {
  createEnvironment,
  E2E_TEST_TIMEOUT_MS,
  LISTENING,
  startProcess,
  useProcesses,
  type ListeningRun,
  type Readiness,
} from "./processes.js";
export {
  fetchUntilCompleteSnapshot,
  findQuoteLine,
  shutDownQuoteApp,
  startQuoteApp,
  startQuoteHub,
  toQuoteFilePattern,
  toQuoteRepositoryPath,
  toQuoteUrl,
  waitForQuoteStatus,
  type QuoteApp,
} from "./quote-app.js";
export { fetchInARow } from "./requests.js";
