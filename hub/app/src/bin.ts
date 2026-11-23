#!/usr/bin/env node
// The micafox-hub executable, and the `./cli` export tools/testkit starts (ADR 0038); runCli holds the logic

// Before the bundle loads, as Node maps only the files it loads after this: stack traces then point at the sources
process.setSourceMapsEnabled(true);
const { runCli } = await import("./cli.js");
await runCli(process.argv.slice(2), process);
