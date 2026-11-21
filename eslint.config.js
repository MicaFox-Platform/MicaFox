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

// The dependency matrix these rules enforce, folder by folder: docs/architecture/overview.md#packages
const MATRIX = "docs/architecture/overview.md#packages";

// Product code (packages/, hub/, ee/) never imports tools/ or sandbox/: only the sandbox apps use the test kit
const TESTKIT_BAN = { name: "@micafox/testkit", message: `Only the sandbox/ apps use @micafox/testkit (${MATRIX}).` };
const SANDBOX_BAN = { regex: "^@micafox/example-", message: `Product code never imports sandbox/ (${MATRIX}).` };

// Nothing imports ee/ but hub/app, and only through #ee and #ee/web: ADR 0023
const EE_BAN = [
  {
    regex: String.raw`^@micafox/hub-ee(/|$)|(^|/)ee(/|$)`,
    message: "Only hub/app imports ee/, and only as #ee or #ee/web (ADR 0023).",
  },
];
const EE_ALIAS_BAN = { regex: "^#ee(/|$)", message: "Only hub/app/src imports #ee and #ee/web (ADR 0023)." };

// A package's sources import only the @micafox packages its row of the matrix allows, any of their entries;
// @typescript-eslint/no-restricted-imports, so it stacks with the rules on `no-restricted-imports`
const restrictDependencies = ({ files, ignores = [], allowed, message, allowEe = false }) => ({
  files,
  ignores,
  rules: {
    "@typescript-eslint/no-restricted-imports": [
      "error",
      {
        patterns: [
          ...EE_BAN,
          ...(allowEe ? [] : [EE_ALIAS_BAN]),
          SANDBOX_BAN,
          { regex: `^@micafox/(?!(${allowed.join("|")})(/|$))`, message: `${message} (${MATRIX})` },
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

// The hub app is run, never imported: only the test kit starts it, through its ./cli entry (ADR 0038). The rows
// below already reject it; this covers everything else
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
  // Whole folders, tests and configs included; the rows of their sources below replace these with their own lists
  {
    files: ["packages/**"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            ...EE_BAN,
            EE_ALIAS_BAN,
            SANDBOX_BAN,
            { regex: "^@micafox/hub(-|/|$)", message: `packages/ never imports hub/ (${MATRIX}).` },
          ],
        },
      ],
    },
  },
  {
    files: ["hub/**", "ee/**"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            ...EE_BAN,
            EE_ALIAS_BAN,
            APP_BAN,
            SANDBOX_BAN,
            { regex: "^@micafox/sdk(/|$)", message: `The hub never imports the SDK (${MATRIX}).` },
          ],
        },
      ],
    },
  },
  // packages/: MIT building blocks, which never import hub/, ee/, tools/ or sandbox/
  restrictDependencies({
    files: ["packages/protocol/src/**"],
    allowed: ["protocol"],
    message: "@micafox/protocol imports no other @micafox package",
  }),
  restrictDependencies({
    files: ["packages/sdk/src/**"],
    allowed: ["protocol", "sdk"],
    message: "@micafox/sdk imports only @micafox/protocol",
  }),
  restrictDependencies({
    files: ["packages/ui/src/**"],
    allowed: [],
    message: "@micafox/ui imports no @micafox package",
  }),
  // hub/: the open hub takes only protocol and ui from packages/, never the SDK
  restrictDependencies({
    files: ["hub/core/src/**"],
    allowed: ["protocol", "ui"],
    message: "hub-core imports only @micafox/protocol and @micafox/ui",
  }),
  restrictDependencies({
    files: ["hub/*/src/**"],
    ignores: ["hub/core/**", "hub/app/**"],
    allowed: ["protocol", "hub-core", "ui"],
    message: "A hub feature imports only @micafox/protocol, hub-core and ui, never another feature",
  }),
  restrictDependencies({
    files: ["hub/app/src/**"],
    allowed: ["protocol", "ui", "hub-core", "hub-[a-z0-9-]+"],
    message: "hub/app imports the protocol, ui and the hub packages, and ee/ only through #ee",
    allowEe: true,
  }),
  // ee/: the paid extension builds on the open hub like a feature does, and never imports hub/app
  restrictDependencies({
    files: ["ee/*/src/**"],
    allowed: ["protocol", "ui", "hub-core", "hub-[a-z0-9-]+"],
    message: "ee/ imports only @micafox/protocol, ui, hub-core and the hub features, never hub/app",
  }),
  restrictBrowserImports(["hub/*/src/web/**", "ee/*/src/web/**"], SERVER_CODE),
  restrictBrowserImports(["hub/*/src/schema/**", "ee/*/src/schema/**"], [...SERVER_CODE, ...WEB_CODE]),
  restrictBrowserImports(["hub/app/src/web/**"], [...SERVER_CODE, ...APP_SERVER_CODE]),
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
    // The test kit drives the sandbox apps' end-to-end tests; product code never depends on it
    files: ["{packages,hub,ee}/**/*.ts", "{packages,hub,ee}/**/*.tsx"],
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
