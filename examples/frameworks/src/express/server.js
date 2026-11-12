// An Express 5 app in CommonJS, run with plain `node`: `require()` loads the SDK's `dist/cjs` build. The SDK starts on
// the first lines, before Express and the routes load, and is configured by the MICAFOX_* environment variables.

const { micafox } = require("@micafox/sdk");

// A test choice, not a recommendation: a restarted hub sees the app again within a second
micafox.configure({ hubConnector: { reconnect: { minDelayMs: 100, maxDelayMs: 1000 } } });
micafox.run();

const express = require("express");

const { quote } = require("./quote.js");

const app = express();
app.get("/quote", quote);

const server = app.listen(Number(process.env.PORT ?? "0"), "127.0.0.1", () => {
  console.log(`listening on port ${String(server.address().port)}`);
});

process.once("SIGTERM", () => {
  // The server first, so no request is captured after the debugger has stopped; stop() sends the buffered snapshots
  server.close(() => {
    void micafox.stop().then(() => {
      console.log("micafox stopped");
    });
  });
});
