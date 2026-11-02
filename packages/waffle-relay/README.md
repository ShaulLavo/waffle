# waffle-relay

An optional, authenticated outbound HTTP relay for Waffle, with one shared implementation for Node, Bun, and fixed-origin Cloudflare Workers.

```ts
import { createRelayFetch } from "waffle-relay";

const relay = createRelayFetch({ endpoint, credential });
const helper = network.createHelper({ ring, fetch: relay.fetch });
// On shutdown, dispose the helper before closing the relay.
helper.dispose();
await relay.close();
```

`endpoint` and `credential` come from the trusted host application, never guest headers, environment variables, or URLs. No relay loads or runs unless the host explicitly imports and injects it.

See [configuration and limits](docs/reference.md) and [hosting](docs/hosting.md).
