# Persist the filesystem

Keep files between page loads with `mode: "fast"`, make a write durable with `flush()`, and decide what happens when a second tab opens the same workspace. This guide assumes you finished [Getting started](../getting-started.md).

## Choose a mode

`mode` picks a guarantee, not a storage API.

| Mode       | Behavior                                                                  | Use it for                     |
| ---------- | ------------------------------------------------------------------------- | ------------------------------ |
| `"memory"` | Volatile. Nothing survives the page.                                      | Tests and throwaway runtimes.  |
| `"fast"`   | Writes return from memory. Saved to IndexedDB at checkpoints and `flush`. | Workspaces that outlive a tab. |
| `"safe"`   | Reserved. Throws `UNSUPPORTED_VFS`.                                       | Nothing yet.                   |

Omitting `mode` means `"fast"`. `name` selects the saved workspace and defaults to `waffle-workspace`. See [Filesystem modes](../vfs.md) for the full contract.

## Save a write

A write returns when shared memory has it, not when IndexedDB does. Await `flush()` to wait for storage. Create `persist.ts`. It counts page loads:

```ts
import { createRuntime, measureSharedMemory } from "waffle";

const runtime = createRuntime({
  sharedMemory: await measureSharedMemory(),
  filesystem: { workerURL: "/fs-worker.js", mode: "fast", name: "notes" },
});
try {
  let note = "";
  try {
    note = new TextDecoder().decode(await runtime.filesystem.readFile("/notes.txt"));
  } catch {
    // First visit: the file does not exist yet.
  }
  const visits = Number(note || "0") + 1;
  await runtime.filesystem.writeFile("/notes.txt", String(visits));
  await runtime.filesystem.flush();
  document.body.textContent = `visit ${visits}`;
} finally {
  await runtime.dispose();
}
```

Bundle it with `fs-worker.ts` as in Getting started and load the page three times in one browser profile. The page shows `visit 1`, then `visit 2`, then `visit 3`.

If you skip `flush()` and close the tab right away, the last write can be lost. A checkpoint interval is a scheduling target, not a limit on how much you can lose. [Storage](../storage.md) lists what each failure does to saved data.

## Handle a second tab

Only one page can own a persistent workspace. `whenBusy` decides what a second page does:

- `"takeover"` is the default for IndexedDB. The new page steals the Web Lock and the old page fails.
- `"wait"` queues the new page until the owner closes.

Watch the state to tell the user. Create `busy.ts`:

```ts
import { createRuntime, measureSharedMemory } from "waffle";

const whenBusy =
  new URLSearchParams(location.search).get("whenBusy") === "wait" ? "wait" : "takeover";
const statuses: string[] = [];
const runtime = createRuntime({
  sharedMemory: await measureSharedMemory(),
  filesystem: {
    workerURL: "/fs-worker.js",
    mode: "fast",
    name: "busy-demo",
    whenBusy,
    onStateChange: (state) => {
      statuses.push(state.status);
      document.body.textContent = `${whenBusy}: ${statuses.join(" > ")} lost=${runtime.filesystem.ownershipLost}`;
    },
  },
});
```

Open the page in two tabs of one profile. With `?whenBusy=wait`, the second tab stays at:

```text
wait: waiting lost=false
```

and becomes `ready` after you close the first tab. Without the parameter, both tabs reach `ready`, then the first one changes to:

```text
takeover: ready > failed lost=true
```

A failed page must stop using the runtime and tell the user. The state values are `"opening"`, `"waiting"`, `"ready"`, `"failed"` and `"disposed"`. [Storage](../storage.md) describes waiting, takeover, cancellation and disposal in full.
