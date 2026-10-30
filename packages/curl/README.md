# waffle-curl

An optional curl-like HTTP command over caller-supplied Fetch and guest I/O.

```ts
import { createCurlCommand } from "waffle-curl";
const curl = createCurlCommand();
await curl.run(invocation);
await curl.dispose();
```

Waffle executable admission is blocked on runtime-native host commands. This is a
portable library, not an installable runtime command or supplied interpreter.
See [the command contract](docs/compatibility.md) for flags, exits, and limitations.
