import js from "@eslint/js";
import vitest from "@vitest/eslint-plugin";
import { createNodeResolver, importX } from "eslint-plugin-import-x";
import tseslint from "typescript-eslint";

/** @type {import("eslint").Linter.Config[]} */
export default [
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    ignores: ["**/dist/**", "**/coverage/**", "**/node_modules/**", "**/.next/**", "**/*.d.ts", "**/*.js"],
  },

  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
    plugins: {
      "import-x": importX,
    },
    settings: {
      // NodeNext imports use `.js` specifiers that point at `.ts` sources
      "import-x/resolver-next": [createNodeResolver({ extensionAlias: { ".js": [".ts", ".js"] } })],
    },
    rules: {
      "import-x/no-cycle": "error",
      "import-x/no-relative-packages": "error",
      "import-x/no-duplicates": "error",
      "import-x/order": [
        "error",
        {
          groups: [
            ["builtin", "external", "internal"],
            ["parent", "sibling", "index"],
          ],

          "newlines-between": "always",

          alphabetize: {
            order: "asc",
            caseInsensitive: true,
          },
        },
      ],

      "import-x/no-default-export": "error",

      "no-warning-comments": ["error", { terms: ["todo", "fixme", "xxx", "hack"] }],
      // Arrow functions by default; a `function` expression stays allowed where `this` or a generator needs it
      "func-style": ["error", "expression"],
      "prefer-arrow-callback": "error",

      "max-lines": ["error", { max: 300, skipBlankLines: true, skipComments: true }],
      "max-lines-per-function": ["error", { max: 50, skipBlankLines: true, skipComments: true }],
      "max-depth": ["error", 3],
      complexity: ["error", 10],
      "@typescript-eslint/max-params": ["error", { max: 3 }],

      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-else-return": ["error", { allowElseIf: false }],
      "no-nested-ternary": "error",
      "no-param-reassign": "error",
      "object-shorthand": "error",
      "prefer-const": "error",
      "prefer-template": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSEnumDeclaration",
          message: "Use a union of string literals: enums are not erasable and do not survive JSON.",
        },
        {
          selector: "ForInStatement",
          message: "Use for...of over Object.keys() or Object.entries(): for...in walks the prototype chain.",
        },
        {
          selector: ":matches(PropertyDefinition, MethodDefinition) > PrivateIdentifier.key",
          message: "Use the TypeScript `private` modifier, not `#private`.",
        },
      ],

      "@typescript-eslint/array-type": ["error", { default: "array-simple" }],
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        { assertionStyle: "as", objectLiteralTypeAssertions: "never" },
      ],
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/prefer-readonly": "error",
      "@typescript-eslint/switch-exhaustiveness-check": ["error", { requireDefaultForNonUnion: true }],
      "@typescript-eslint/naming-convention": [
        "error",
        { selector: "default", format: ["camelCase"] },
        { selector: "import", format: ["camelCase", "PascalCase"] },
        { selector: "variable", modifiers: ["const"], format: ["camelCase", "UPPER_CASE"] },
        { selector: "variable", modifiers: ["destructured"], format: null },
        { selector: "parameter", format: ["camelCase"], leadingUnderscore: "allow" },
        { selector: "classProperty", modifiers: ["static", "readonly"], format: ["camelCase", "UPPER_CASE"] },
        { selector: "typeLike", format: ["PascalCase"] },
        { selector: "interface", format: ["PascalCase"], custom: { regex: "^I[A-Z]", match: false } },
        // Wire names such as HTTP headers are quoted and keep the spelling their protocol gives them
        {
          selector: ["objectLiteralProperty", "typeProperty", "objectLiteralMethod", "typeMethod"],
          modifiers: ["requiresQuotes"],
          format: null,
        },
      ],
    },
  },

  {
    // Tools such as Vitest load their config through a default export
    files: ["**/*.config.ts"],
    rules: {
      "import-x/no-default-export": "off",
    },
  },

  {
    files: ["**/*.test.ts", "**/*.test-d.ts"],
    plugins: { vitest },
    // Lets `vitest/expect-expect` count `expectTypeOf()` and `assertType()` as assertions
    settings: { vitest: { typecheck: true } },
    rules: {
      ...vitest.configs.recommended.rules,
      "vitest/no-disabled-tests": "error",
      "vitest/no-conditional-in-test": "error",
      "vitest/require-to-throw-message": "error",
      "vitest/max-nested-describe": ["error", { max: 2 }],
      "max-lines": "off",
      "max-lines-per-function": "off",
    },
  },
];
