// A constant, not a runtime read of package.json: a JSON import, `import.meta` and `require` each break one of the
// ES module and CommonJS builds (ADR 0013). version.test.ts keeps it equal to package.json.
/** The SDK's own version, sent in every `hello`. */
export const SDK_VERSION = "0.1.0";
