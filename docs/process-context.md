# Runtime process identity

`createRuntime({ hostIdentity })` accepts the identity of the runtime host. All three fields are required when configured.

| Field      | Meaning                                                                                             |
| ---------- | --------------------------------------------------------------------------------------------------- |
| `uid`      | Host-supplied runtime user ID, an integer from 0 through 4294967294.                                |
| `euid`     | Host-supplied runtime effective user ID, in the same range. It need not equal `uid`.                |
| `hostname` | Host-supplied runtime hostname. Empty names, ASCII whitespace, and control characters are rejected. |

The embedder obtains these values from its actual host or explicitly establishes them as its runtime's identity. Waffle cannot discover a browser user's operating-system credentials or machine hostname. The web origin, build machine, guest environment, and random IDs are not identity sources. Configuring these values does not grant filesystem permissions or implement user switching.

Omitting `hostIdentity` produces `runtime.hostIdentity === null`. Adapters must report unsupported identity when they need UID, EUID, or hostname and the host is absent. Waffle never supplies `0`, the browser origin, or `localhost` as a substitute. Explicitly configured UID or EUID 0 remains valid.

## Process metadata

`GuestLauncher` receives `RuntimeProcessContext`, the existing process context plus immutable `identity` metadata:

```ts
interface RuntimeProcessIdentity {
  readonly pid: number;
  readonly parentPid: number;
  readonly host: RuntimeHostIdentity | null;
}
```

`pid` and `parentPid` come from Waffle's process table. A root's actual parent is 0, which denotes no parent in this runtime. Child ancestry remains the actual spawning process, including after its parent exits. These IDs are runtime process IDs, not browser or native OS process IDs.

The page snapshots host configuration when it creates the runtime. Mutating the caller's object cannot change launched or future processes. Broker-launched workers receive that same host identity regardless of adapter request fields, child environment variables, or adapter-specific spawn data. Waffle does not implement credential changes, so descendants inherit the runtime host identity.

## Worker adapters and externally launched roots

`WorkerSetupContext.identity` exposes the worker's immutable process identity. Bootstrap reads its PID and parent PID from the admitted `runtimeProcess` shared transport. Without that transport, `identity` is null; bootstrap cannot invent ancestry.

An adapter that launches an interactive root directly passes the owning page's host identity alongside its real transport:

```ts
worker.postMessage(
  {
    module,
    args,
    env,
    filesystem,
    runtimeProcess,
    hostIdentity: runtime.hostIdentity,
  },
  [filesystem.port],
);
```

Broker launches set `hostIdentity` themselves. Adapter callbacks can read `context.identity` without editing `proc/types.ts` or adding a second runtime. Guest-specific UID, EUID, PPID, and hostname imports remain the guest adapter's responsibility. Waffle's preview1 ABI gains no invented POSIX imports.

## Preparing descendants before entry

A root controller can act on every later descendant of its root before that descendant's program launches. This includes processes started by other packages' adapters, such as Bun. Pass `prepareDescendant` to `adoptRuntimeRoot`:

```ts
const supervisor = await service.ready();
function removeMember(pid: number) {
  const member = members.get(pid);
  if (!member) return;
  members.delete(pid);
  authority.removeMember(member);
}
const unsubscribe = supervisor.onChildExit(({ pid }) => removeMember(pid));
await service.adoptRuntimeRoot(root, {
  retired() {
    unsubscribe();
    members.clear();
  },
  prepareDescendant({ pid, job }) {
    const group = groups.get(job);
    if (!group) return undefined;
    const admitted = authority.admitExisting({ group, pid });
    if (admitted.kind === "error") throw new Error(admitted.code);
    members.set(pid, admitted.value.member);
    return undefined;
  },
});
```

Waffle calls the hook synchronously, once per descendant whose immutable root is this root, in the root's own process directory. The call comes after the descendant's reservation is admitted and immediately before its adapter launcher runs, so the guest cannot enter first. `data` is a frozen clone of the spawn metadata without `filesystem` and `pipeRegistry`. Its fields are the parent's claims, not membership. The hook does not change the metadata the guest receives.

The hook must return `undefined`. A throw or any other return value, including a promise, fails the start. A rejected promise is only reported. After the hook, Waffle rechecks in the same turn that the process has no outcome and the root controller is still registered. A kill from another worker can still land after that point; the guest's entry commit then loses to the kill and the guest never runs. Waffle captures the hook when it adopts the root, and later edits to the options object have no effect.

Clean up per-process state from `supervisor.onChildExit`, which reports each completed exit once, including start failures and kills before entry. Keep the subscription until root retirement, then unsubscribe and clear any remaining member handles. The root's terminal authority is already gone at retirement. Runtime disposal can clear exit listeners before pending exits complete. If adoption fails, release the subscription in the caller's cleanup. Do not use `registerController` for this: it allows one controller per process, and the adapter that launches the process may register its own. Worker stop and physical cleanup stay with Waffle.

## Identity helpers

`waffle/browser/process-context` exports the identity types, `snapshotHostIdentity`, and `createProcessIdentity`. These dependency-free helpers support custom adapters without loading the process supervisor. The page facade still loads process implementation only when its process service is requested.

## Verification scope

`tests/descendant-preparation.test.ts` runs the real broker, supervisor, shared directory and terminal authority. The root admits a same-job grandchild in the hook, and the grandchild reads queued input through its unchanged identity-only context. The tests also cover cleanup alongside a foreign adapter's controller, hook failures, a kill, root exit or disposal from inside the hook, a cross-worker kill before entry, and root isolation. The adapter's Worker is replaced by a launch callback.

`tests/runtime-process-context.test.ts` changes configured UID, EUID, and hostname and checks values stored by an original Wasm fixture. It verifies real shared-directory ancestry, unavailable host identity, frozen snapshots, and rejection of adapter and environment overrides. Its in-process Worker fixture runs the actual broker and bootstrap. It is not a native-browser campaign or a Shell compatibility-score claim. Shell must adopt the API and wire its own guest imports before its automatic variables can use these values.
