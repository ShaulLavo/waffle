# Waffle Python

CPython 3.15.2 and its standard library as a lazy WASI program for Waffle.

Stage the qualified assets, then create the family program on the page's existing runtime:

```sh
node scripts/stage-assets.ts --receipt-sha256 HEX /path/to/accepted-python-artifact
```

```ts
import { createPythonPackage } from "@waffle/python";
const python = createPythonPackage(runtime);
// Install with pythonLauncher(launcher); see the package integration guide.
```

[Runtime contract](docs/python.md) · [Build and provenance](docs/python-build.md) · [Package integration](docs/package-integration.md)
