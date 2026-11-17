// A route handler on the Edge runtime, where the SDK does not run: instrumentation.ts only logs that.

export const runtime = "edge";

/** `GET /edge`: answers which runtime served it. */
export const GET = (): Response => Response.json({ runtime: process.env.NEXT_RUNTIME ?? "unknown" });
