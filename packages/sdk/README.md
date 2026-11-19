# @micafox/sdk

The MicaFox SDK for Node.js apps: set non-breaking breakpoints in a running app and capture snapshots of its
variables, without stopping it.

```sh
pnpm add @micafox/sdk
```

Node.js 22 or later, with `import` or `require()`. Set `MICAFOX_HUB_URL`, `MICAFOX_TOKEN` and `MICAFOX_SERVICE` in
the deployment, start the debugger as early as possible, and stop it in your app's shutdown:

```ts
import { micafox } from "@micafox/sdk"; // or: const { micafox } = require("@micafox/sdk");

micafox.run();

process.once("SIGTERM", () => {
  void micafox.stop();
});
```

No method throws into your app: an internal error turns MicaFox off and the app keeps running.

Full reference: [docs/api/sdk](https://github.com/MicaFox-Platform/MicaFox/blob/main/docs/api/sdk/overview.md).
