# Configure program loading

Choose the programs your page installs. Unlisted programs are absent. Waffle never searches a remote catalog or creates an interpreter to satisfy a missing command.

```ts
import { createRuntime } from "waffle";
import { coreutils } from "waffle-coreutils";
import { ripgrep } from "waffle-ripgrep";
import { sed } from "waffle-sed";
import { findutils } from "waffle-findutils";

const runtime = createRuntime({
  programs: { preload: [coreutils.pick("ls", "cat", "echo")], onDemand: [ripgrep, sed, findutils] },
});
await runtime.programs.ready;
await runtime.programs.preload("rg");
```

These last three lines are a complete playground startup example after the imports. They do not change any existing playground's policy.

`createRuntime` returns synchronously. `programs.ready` waits for the configured markers, registrations, payload preparation, and preload compilation. Await it before enabling commands that require those preloads. A rejected preload leaves its program registered with an error state. Retry with `preload`. The original startup promise keeps its original result. The process service waits for initial metadata registration, not for unrelated preloads.

`onDemand` writes markers and registers executable metadata. Lookup, including aliases and missing names, does not fetch or compile programs. The first execution prepares and compiles its program. Both preload and execution use Waffle's interrupt rewriter. Preloading does not launch a process or instantiate a guest.

To schedule work during idle time, call `preload` from your own idle callback and handle its promise. Waffle adds no implicit idle scheduler.

## Add programs after startup

```ts
import { base } from "waffle-base";

await runtime.programs.onDemand(coreutils.pick("wc"));
await runtime.programs.preload(sed);
await runtime.programs.onDemand(base);
```

A family installs all of its programs. A pick installs only the named programs and their aliases. `base` selects all five ordinary families. It excludes Python and Git. Picks and base retain each original family definition and payload owner. Readding that same definition is idempotent. A different package identity or definition claiming an occupied path rejects before changing files.

`preload` accepts package definitions to add and load, or names and absolute paths already installed in the collection. A bare name is the canonical path's final component. An uninstalled name rejects without fetching. Concurrent preload and execution share the existing registration's module promise. A failed attempt can be retried.

The default launcher uses Waffle's preview1 worker. Set `programs.launcher` when your embedder supplies its own launcher. No worker starts during preload.

## Inspect and remove programs

```ts
const rg = runtime.programs.get("rg");
if (rg) await rg.preload();
for (const program of runtime.programs) console.log(program.name, program.mode, program.state);
await rg?.remove();
```

The collection is iterable and has `forEach`. `status()` returns its current handles. A handle's desired `mode` is `onDemand` or `preload`. Its actual `state.kind` is `registered`, `preparing`, `loaded`, `error`, or `removed`. An error state also contains `error`. Switching a loaded program to on-demand mode does not discard its compiled module.

Removal closes new loading immediately, removes unchanged owned files, and waits for in-flight loads and physically stopped consumers. It does not kill running processes. A retiring program keeps its path reserved until removal completes. Await removal before readding it. An old handle cannot preload or remove its replacement. The last selected member releases its family's payload. `runtime.dispose()` stops its owned consumers through the existing fences and releases collection-owned payloads before closing the filesystem.

A program already accepted before removal may still need to finish or report cancellation. Files that another writer replaced are not owned by the installation and survive removal. A persistent marker reused from a previous page remains on disk but is not registered after removal.

## Declare optional interpreters

Python is a runtime-bound package because it owns standard-library files.

```ts
import { createPythonPackage } from "@waffle/python";
const python = createPythonPackage(runtime);
await runtime.programs.onDemand(python);
```

Git is a script package. Register your interpreter and its regular executable file explicitly before using Git.

```ts
import { createGitPackage } from "waffle-git/program";
const git = createGitPackage({ interpreter: "/bin/bun" });
await runtime.programs.onDemand(git);
```

Git lookup checks the declared interpreter's live registration without fetching Git's script, preparing a payload, or loading the interpreter. Git preload and execution prepare the script and resolve that existing interpreter. Its registered adapter launches the process. No hidden Bun or Python instance is created. A missing interpreter produces normal missing-executable admission.

The lower-level `registerProgram` and `installPrograms` APIs remain available for caller-driven registration and installation. They do not implicitly install base. The collection does not own registrations created outside it. Live filesystem admission still governs all execution, including symlinks, user-written shebang scripts, deleted markers, and non-runnable files.

## Publish family metadata

Family packages create their catalog with `defineProgramPackage` from `waffle/programs/catalog`. This small entry imports no runtime owner, process service, or compiler. Bun can read its source before preparing Node exports. Node consumers use the prepared catalog module. Picks preserve the same package identity across source and prepared entrypoints.
