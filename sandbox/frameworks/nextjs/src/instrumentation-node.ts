// Starts the SDK on the Node.js runtime of `next start`, configured by the MICAFOX_* environment variables.

/** Loads and starts the SDK, and starts stopping it on SIGTERM. */
export const startMicafox = async (): Promise<void> => {
  // Node.js loads the SDK from node_modules, never from a bundle. An app that installs @micafox/sdk from the registry
  // gets that from `serverExternalPackages: ["@micafox/sdk"]` in next.config.ts; this example links the SDK from the
  // workspace, which Turbopack always bundles, so the import itself tells Turbopack to leave it alone
  const { micafox } = await import(/* turbopackIgnore: true */ "@micafox/sdk");

  // A test choice, not a recommendation: a restarted hub sees the app again within a second
  micafox.configure({ hubConnector: { reconnect: { minDelayMs: 100, maxDelayMs: 1000 } } });
  micafox.run();

  // On SIGTERM `next start` closes its server, finishes pending requests and exits by itself; stop() runs beside it
  // and closes the hub connection. Breakpoints in bundled route handlers do not resolve yet, so no snapshot waits to
  // be sent
  process.once("SIGTERM", () => {
    console.log("micafox stopping");
    void micafox.stop();
  });
};
