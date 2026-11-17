/** The message types of one module, by who sends them. */
interface ModuleTypes {
  fromHub: ReadonlySet<string>;
  fromSdk: ReadonlySet<string>;
}

/** What `agreeOnModules()` made of a `welcome`. */
export interface ModuleAgreement {
  /** The modules both `hello` and `welcome` list: the ones the session carries. */
  agreed: ReadonlySet<string>;
  /** The modules of `hello` that `welcome` left out, in the order `hello` lists them. */
  refused: string[];
}

// A Map, so a hub cannot reach Object.prototype with a module such as "toString". New modules are added here.
const KNOWN_MODULES: ReadonlyMap<string, ModuleTypes> = new Map([
  ["debugger", { fromHub: new Set(["breakpoints"]), fromSdk: new Set(["breakpointStatus", "snapshot"]) }],
]);

// A hub that lists more modules than this is not sending a module list the connector needs to read in full
const MAX_WELCOME_MODULES = 32;

/** The types `module` sends and receives; `undefined` when the SDK does not know the module. */
export const findModuleTypes = (module: string): ModuleTypes | undefined => KNOWN_MODULES.get(module);

/**
 * The modules of `welcomeModules`, its first 32 entries only, that are strings `helloModules` listed; and the
 * modules of `helloModules` that are not among them.
 */
export const agreeOnModules = (
  helloModules: readonly string[],
  welcomeModules: readonly unknown[],
): ModuleAgreement => {
  const offered = new Set(helloModules);
  const agreed = new Set<string>();
  for (const entry of welcomeModules.slice(0, MAX_WELCOME_MODULES)) {
    if (typeof entry === "string" && offered.has(entry)) {
      agreed.add(entry);
    }
  }

  return { agreed, refused: [...offered].filter((module) => !agreed.has(module)) };
};
