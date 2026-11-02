# waffle-curl

An optional curl-like HTTP command over caller-supplied Fetch and guest I/O.

```ts
import { createCurlCommand } from "waffle-curl";
const curl = createCurlCommand();
await curl.run(invocation);
await curl.dispose();
```

`createCurlPackage(options)` also installs this command through Waffle's host-command API.
See [the command contract](docs/compatibility.md) for flags, exits, and limitations.
