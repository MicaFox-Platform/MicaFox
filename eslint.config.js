import config from "@micafox/configs/eslint";

const TESTS = ["**/*.test.ts", "**/*.test.tsx", "**/*.test-d.ts"];

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

const TESTKIT_BAN = { name: "@micafox/testkit", message: "Only examples use @micafox/testkit (CLAUDE.md#packages)." };

// Nothing imports ee/ but packages/hub, and only through #ee and #ee/web: ADR 0023
const EE_BAN = [
  {
    regex: String.raw`^@micafox/hub-ee(/|$)|(^|/)ee(/|$)`,
    message: "Only packages/hub imports ee/, and only as #ee or #ee/web (ADR 0023).",
  },
];
const EE_ALIAS_BAN = { regex: "^#ee(/|$)", message: "Only packages/hub/src imports #ee and #ee/web (ADR 0023)." };

// A hub package's sources import only the @micafox packages above it in docs/architecture/hub/overview.md#packages,
// any of their entries; @typescript-eslint/no-restricted-imports, so it stacks with the rules on `no-restricted-imports`
const restrictHubDependencies = ({ files, ignores = [], allowed, message, allowEe = false }) => ({
  files,
  ignores,
  rules: {
    "@typescript-eslint/no-restricted-imports": [
      "error",
      {
        patterns: [
          ...EE_BAN,
          ...(allowEe ? [] : [EE_ALIAS_BAN]),
          { regex: `^@micafox/(?!(${allowed.join("|")})(/|$))`, message },
        ],
      },
    ],
  },
});

// The browser loads ./web, and ./schema is shared with it: neither imports server code, Node built-ins included, nor
// does ./schema import ./web. docs/architecture/hub/overview.md#packages
const SERVER_CODE = [
  { regex: String.raw`^\.{1,2}/(.*/)?server(/|$)`, message: "./web and ./schema never import server code." },
  {
    regex: "^@micafox/hub-[a-z0-9-]+$",
    message: "A package's root entry is its server code: import its ./web or ./schema entry.",
  },
];
const WEB_CODE = [
  {
    regex: String.raw`^\.{1,2}/(.*/)?web(/|$)`,
    message: "./schema is shared with the server: it never imports ./web.",
  },
  {
    regex: "^@micafox/[a-z0-9-]+/web$",
    message: "./schema is shared with the server: it never imports a ./web entry.",
  },
];
// The app's own src/web/ is the browser entry: it takes #ee/web, never #ee or the app's server files above it. Its
// Layout is flat (docs/architecture/hub/app.md#layout), so any `../` leaves it
const APP_SERVER_CODE = [
  { regex: "^#ee$", message: "#ee is the server extension: the browser imports #ee/web." },
  { regex: String.raw`^\.\./`, message: "src/web/ is the browser's: the files above it are the app's server code." },
];
const restrictBrowserImports = (files, patterns) => ({
  files,
  ignores: TESTS,
  rules: {
    "no-restricted-imports": ["error", { paths: [TESTKIT_BAN], patterns }],
    "import-x/no-nodejs-modules": "error",
  },
});

// The hub app is run, never imported: only the test kit starts it, through its ./cli entry (ADR 0038). The hub
// packages' own rows already reject it; this covers everything else
const APP_BAN = {
  regex: "^@micafox/hub(/|$)",
  message: "Nothing imports the hub app but tools/testkit, through @micafox/hub/cli (ADR 0038).",
};
const TESTKIT_APP_BAN = {
  regex: "^@micafox/hub(?!/cli$)(/|$)",
  message: "The test kit starts the hub only through @micafox/hub/cli (ADR 0038).",
};

const hubRules = [
  {
    rules: { "@typescript-eslint/no-restricted-imports": ["error", { patterns: [...EE_BAN, EE_ALIAS_BAN, APP_BAN] }] },
  },
  {
    files: ["tools/testkit/**"],
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", { patterns: [...EE_BAN, EE_ALIAS_BAN, TESTKIT_APP_BAN] }],
    },
  },
  restrictHubDependencies({
    files: ["packages/ui/src/**"],
    allowed: [],
    message: "@micafox/ui imports no @micafox package (docs/architecture/hub/overview.md#packages).",
  }),
  restrictHubDependencies({
    files: ["packages/hub-core/src/**"],
    allowed: ["protocol", "ui"],
    message: "hub-core imports only @micafox/protocol and @micafox/ui (docs/architecture/hub/overview.md#packages).",
  }),
  restrictHubDependencies({
    files: ["packages/hub-*/src/**"],
    ignores: ["packages/hub-core/**"],
    allowed: ["protocol", "hub-core", "ui"],
    message:
      "A hub feature imports only @micafox/protocol, hub-core and ui, never another feature " +
      "(docs/architecture/hub/overview.md#packages).",
  }),
  restrictHubDependencies({
    files: ["packages/hub/src/**"],
    allowed: ["protocol", "ui", "hub-core", "hub-[a-z0-9-]+"],
    message: "The hub app imports the hub packages and the protocol (docs/architecture/hub/overview.md#packages).",
    allowEe: true,
  }),
  restrictBrowserImports(["packages/hub-*/src/web/**"], SERVER_CODE),
  restrictBrowserImports(["packages/hub-*/src/schema/**"], [...SERVER_CODE, ...WEB_CODE]),
  restrictBrowserImports(["packages/hub/src/web/**"], [...SERVER_CODE, ...APP_SERVER_CODE]),
];

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
  {
    // The test kit drives the examples' end-to-end tests; the packages never depend on it
    files: ["packages/**/*.ts", "packages/**/*.tsx"],
    rules: { "no-restricted-imports": ["error", { paths: [TESTKIT_BAN] }] },
  },
  ...hubRules,
  // The logger moves with the connector if it becomes its own package: docs/architecture/sdk/logger.md
  ...restrictImports("logger", []),
  // The connector may become its own package with the logger: docs/architecture/sdk/connector.md#boundaries
  ...restrictImports("connector", ["@micafox/protocol", "ws", "../logger/index.js"]),
  // The debugger imports the connector and the logger, never their files: docs/architecture/sdk/overview.md#packages
  ...restrictImports("debugger", ["@micafox/protocol", "../connector/index.js", "../logger/index.js"]),
];
