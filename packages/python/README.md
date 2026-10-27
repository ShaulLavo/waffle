# Waffle Python

CPython 3.15.2 and its standard library as a lazy WASI program for Waffle.

Stage the qualified assets, then create the family program on the page's existing runtime:

```sh
node scripts/stage-assets.ts /path/to/qualified-python-artifact
```

```ts
import { createPythonPackage } from "@waffle/python";
const python = createPythonPackage(runtime);
// Pass `python` to Waffle's generic installPrograms operation.
```

[Runtime contract](docs/python.md) · [Build and provenance](docs/python-build.md) · [Package integration](docs/package-integration.md)
