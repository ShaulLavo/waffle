# Waffle gh package

An optional gh-compatible command for common agent workflows in Waffle.

```ts
import { createGhPackage } from "waffle-gh/program";
import { jq } from "waffle-jq";

const gh = createGhPackage({ interpreter: "/bin/bun" });
await runtime.programs.onDemand(gh, jq);
```

The interpreter and jq must already be registered or installed by the application. The package creates neither. See [compatibility](docs/compatibility.md).
