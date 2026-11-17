# @micafox/protocol

The MicaFox protocol: the messages between the SDK and a hub, the protocol version and the `Connector` interface.
Types and constants only, for `import` and `require()`.

```sh
pnpm add @micafox/protocol
```

`@micafox/sdk` installs it for you; install it yourself to write a custom connector or hub:

```ts
import type { Connector, Message } from "@micafox/protocol";
import { PROTOCOL_VERSION } from "@micafox/protocol";
```

Full reference: [docs/api/protocol.md](https://github.com/MicaFox-Platform/MicaFox/blob/main/docs/api/protocol.md).
