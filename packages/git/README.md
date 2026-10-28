# waffle-git

Local Git (`init`, `add`, `commit`, `status`, `log`, `diff`, `branch`, `switch`, `checkout`, `merge`, `stash`) for Waffle runtimes, backed by isomorphic-git 1.44.5.

```ts
import { installGitProgram } from "waffle-git/program";

// Needs a JavaScript interpreter on the runtime, e.g. bun-wasm's /bin/bun.
await installGitProgram(runtime, { source: await (await fetch(gitCliUrl)).text() });
// Now `git init`, `git commit -m ...` work from any shell or process on the runtime.
```

`installGit(runtime)` from `waffle-git` is the in-page API on the same backend.

Details, limits and tests: [docs/git-local.md](docs/git-local.md). Dependency notices: `dist/git.NOTICES.txt`.
