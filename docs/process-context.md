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

A root controller can prepare every later descendant of its root, including processes that other guests start. Pass `prepareDescendant` to `adoptRuntimeRoot`:

```ts
await service.adoptRuntimeRoot(root, {
  prepareDescendant({ pid, parentPid, job, data }) {
    const parent = members.get(parentPid);
    if (!parent) return; // launch unchanged
    const plan = must(authority.planMember({ group: parent.group, parent: parent.member }));
    const bound = authority.bindMember({ planned: plan.member, pid });
    if (bound.kind === "error") {
      authority.cancelPlan(plan.member);
      throw new Error(bound.code);
    }
    members.set(pid, { group: parent.group, member: bound.value.member });
    return {
      data: { terminalContext: bound.value.context },
      cancel() {
        authority.removeMember(bound.value.member);
        members.delete(pid);
      },
    };
  },
});
```

Waffle calls the hook once per descendant whose immutable root is this root, in the root's own process directory. The call happens after the descendant's reservation is admitted and before its adapter launches, so the guest cannot enter first. `data` is a clone of the spawn metadata without `filesystem` and `pipeRegistry`. Its fields are the parent's claims, not proof of membership. The hook may reenter process control and may return a promise; the launch waits for it.

The returned `data` is cloned and merged into the descendant's metadata before launch; it cannot replace `filesystem` or `pipeRegistry`. A throw, a rejection, or invalid `data` fails the start. When the hook throws, it owns any partial work. After it returns, `cancel` runs exactly once if the descendant ends without entering its guest: launch or start failure, a kill while the hook was pending, or broker disposal. `cancel` runs before the root's `retired()`. An entered descendant's exit never calls `cancel`. Waffle captures the hook when it adopts the root; later edits to the options object have no effect. Worker stop and physical cleanup are unchanged.

## Identity helpers

`waffle/browser/process-context` exports the identity types, `snapshotHostIdentity`, and `createProcessIdentity`. These dependency-free helpers support custom adapters without loading the process supervisor. The page facade still loads process implementation only when its process service is requested.

## Verification scope

`tests/descendant-preparation.test.ts` runs the real broker, supervisor, shared directory and terminal authority. A same-job grandchild of a direct child is bound and receives a member context before launch, then reads queued input. It also covers a blocked hook, a kill while blocked, hook and launch failures, root isolation, root death and disposal. The adapter's Worker is replaced by a launch callback.

`tests/runtime-process-context.test.ts` changes configured UID, EUID, and hostname and checks values stored by an original Wasm fixture. It verifies real shared-directory ancestry, unavailable host identity, frozen snapshots, and rejection of adapter and environment overrides. Its in-process Worker fixture runs the actual broker and bootstrap. It is not a native-browser campaign or a Shell compatibility-score claim. Shell must adopt the API and wire its own guest imports before its automatic variables can use these values.
