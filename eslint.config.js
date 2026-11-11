import config from "@micafox/configs/eslint";

const TESTS = ["**/*.test.ts", "**/*.test-d.ts"];

const escapeRegex = (text) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

// A component of packages/sdk/src imports only Node built-ins, `allowed` (as written from its root folder) and its
// own modules: a root file imports a file (./backoff.js) or a sub-component's entry (./session/index.js); a
// sub-component's file imports a file of its own or a sibling's entry (../outbound/index.js).
// .claude/rules/code-quality.md#structure
const restrictImports = (component, allowed) => {
  const fromSubComponent = allowed.map((specifier) => (specifier.startsWith("../") ? `../${specifier}` : specifier));
  const message =
    `The ${component} imports only ${[...allowed, "node:*"].join(", ")}, its own files (./<file>.js), a ` +
    "sub-component's ./<folder>/index.js and, from a sub-component, a sibling's ../<folder>/index.js.";
  const rule = (own) => ["error", { patterns: [{ regex: `^(?!${["node:", ...own].join("|")})`, message }] }];
  const exact = (specifiers) => specifiers.map((specifier) => `${escapeRegex(specifier)}$`);
  const root = `packages/sdk/src/${component}`;

  return [
    {
      files: [`${root}/**/*.ts`],
      ignores: TESTS,
      rules: {
        "no-restricted-imports": rule([
          ...exact(fromSubComponent),
          String.raw`\./[a-z0-9-]+\.js$`,
          String.raw`\.\./[a-z0-9-]+/index\.js$`,
        ]),
      },
    },
    {
      files: [`${root}/*.ts`],
      ignores: TESTS,
      rules: { "no-restricted-imports": rule([...exact(allowed), String.raw`\./[a-z0-9-]+(/index)?\.js$`]) },
    },
  ];
};

export default [
  ...config,
  {
    // Editors run ESLint from a package directory;
    // the root tsconfig.json still owns the config and test files
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  // The logger moves with the connector if it becomes its own package: docs/architecture/sdk/logger.md
  ...restrictImports("logger", []),
  // The connector may become its own package with the logger: docs/architecture/sdk/connector.md#boundaries
  ...restrictImports("connector", ["@micafox/protocol", "ws", "../logger/index.js"]),
  // The debugger imports the connector and the logger, never their files: docs/architecture/sdk/overview.md#packages
  ...restrictImports("debugger", ["@micafox/protocol", "../connector/index.js", "../logger/index.js"]),
];
