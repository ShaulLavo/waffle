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

`waffle/browser/process-context` exports the identity types, `snapshotHostIdentity`, and `createProcessIdentity`. These dependency-free helpers support custom adapters without loading the process supervisor. The page facade still loads process implementation only when its process service is requested.

## Verification scope

`tests/runtime-process-context.test.ts` changes configured UID, EUID, and hostname and checks values stored by an original Wasm fixture. It verifies real shared-directory ancestry, unavailable host identity, frozen snapshots, and rejection of adapter and environment overrides. Its in-process Worker fixture runs the actual broker and bootstrap. It is not a native-browser campaign or a Shell compatibility-score claim. Shell must adopt the API and wire its own guest imports before its automatic variables can use these values.
