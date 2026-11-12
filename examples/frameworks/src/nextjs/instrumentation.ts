// Next.js calls register() once per runtime when the server starts. The SDK runs only on the Node.js runtime: on the
// Edge runtime there is no inspector, so it is not even imported there. NEXT_RUNTIME is replaced at build time, so the
// Edge bundle does not contain the SDK.

export const register = async (): Promise<void> => {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startMicafox } = await import("./instrumentation-node");
    await startMicafox();
    return;
  }

  console.warn("MicaFox does not run on the Edge runtime: the SDK is not started");
};
