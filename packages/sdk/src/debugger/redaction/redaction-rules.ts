/** The names whose values never leave the app; the app adds names and cannot remove these (ADR 0012). */
const BUILT_IN_NAMES: readonly string[] = [
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "apikey",
  "accesskey",
  "privatekey",
  "credential",
  "authorization",
  "cookie",
  "session",
  "jwt",
  "bearer",
  "signature",
];

const SEPARATORS = /[_.-]/g;

// A name is matched on its first 256 characters, so a map keyed by huge strings costs little per entry in a pause
const MAX_NAME_LENGTH = 256;

/** Lowercases `name` and removes `_`, `-` and `.`, so `api_key`, `API-KEY` and `apiKey` are all `apikey`. */
export const normalizeName = (name: string): string => name.toLowerCase().replace(SEPARATORS, "");

/** The names to redact, resolved once; matching is by containment of the normalized name. */
export interface RedactionRules {
  /** The number of distinct rules, the built-in ones included. */
  readonly count: number;
  /** Tells whether the value under `name` must be replaced with `redacted` and never read. Never throws. */
  isSecret(name: string): boolean;
}

/** Builds the rules from the built-in names and `extra`; a rule that is empty once normalized is left out. */
export const createRedactionRules = (extra: readonly string[]): RedactionRules => {
  const rules = [...new Set([...BUILT_IN_NAMES, ...extra].map(normalizeName).filter((rule) => rule !== ""))];
  return {
    count: rules.length,
    // O(rules x 256): at most 115 rules, each a short word
    isSecret: (name) => {
      const normalized = normalizeName(name.slice(0, MAX_NAME_LENGTH));
      return rules.some((rule) => normalized.includes(rule));
    },
  };
};
