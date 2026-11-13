// The modules the fake hub accepts: it plays the hub side of docs/api/protocol.md#welcome.

const KNOWN_MODULES = ["debugger"] as const;

/** The modules the fake hub knows, in the order it lists them. */
export type KnownModule = (typeof KNOWN_MODULES)[number];

/**
 * The `welcome.modules` for a hello's `modules`: those of the hub's known modules the hello lists, each once. A hello
 * without a `modules` array, or with entries that are not strings, gets none for them.
 */
export const acceptModules = (helloModules: unknown): KnownModule[] =>
  Array.isArray(helloModules) ? KNOWN_MODULES.filter((module) => helloModules.includes(module)) : [];
