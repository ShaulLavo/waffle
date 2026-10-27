# Install program packages

A program package (coreutils, sed, ripgrep, …) ships WASI programs and the paths they belong at. `installPrograms` from `waffle/programs` puts them on a runtime: it writes one small marker file per path and registers it. Nothing is fetched or compiled until a program first runs. This guide assumes the adapter from [Run a WASI program](run-a-wasi-program.md).

## Describe a package

A package exports a `ProgramPackage`. Write each `wasm` URL as `new URL("./name.wasm", import.meta.url)` in the package's own module, so bundlers emit the file and rewrite the URL:

```ts
import type { ProgramPackage } from "waffle/programs";

export const coreutils: ProgramPackage = {
  name: "coreutils",
  programs: [
    { path: "/usr/bin/ls", aliases: ["/bin/ls"], wasm: new URL("./ls.wasm", import.meta.url) },
    { path: "/usr/bin/env", aliases: ["/bin/env"], wasm: new URL("./env.wasm", import.meta.url) },
  ],
};
```

`path` is the canonical absolute path. Each alias is another regular file that runs the same program and shares its single download and compilation. Programs are WASI Preview 1 commands. They load as source bytes, so they get the same interrupt admission as any other `source` program.

## Install

Register the adapter that should run the programs, then install one or more packages:

```ts
import { installPrograms } from "waffle/programs";

runtime.registerAdapter("preview1", launcher);
const programs = await installPrograms(runtime, [coreutils, sed], { adapter: "preview1" });
const env = { PATH: programs.path.join(":") };
```

The runtime has no global `PATH`. `programs.path` lists the directories that now hold programs, in manifest order. Pass them to whatever spawns processes, such as a shell's environment. `programs.executables` lists every installed path.

## Failures

- Two programs in one call that claim the same path: `ProgramConflictError`, before anything changes.
- A path that is already registered on the runtime, or a file there that isn't this program's marker: the call fails and removes every registration and marker it made. A matching marker left by an earlier page on persistent storage is reused, and is never removed by this installation.
- A download or compile failure fails only that exec (`EIO` for a failed fetch, `ENOEXEC` for bytes that aren't WebAssembly). The next exec tries again.

## Uninstall

`programs.dispose()` unregisters every path, then removes the marker files it created that are still unchanged. Call it once the programs' processes have stopped. `runtime.dispose()` releases registrations on its own.
