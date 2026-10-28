# Worker memory samples

`ProcessService.workerMemory()` returns the latest sampled WebAssembly linear-memory allocation for workers launched through that service's `launchWorker`. The shipped generic preview1 worker supplies the samples. It needs no replacement executor, additional controller, caller-owned memory writer, or timer.

## Launch and read

Use the existing page-owned `Runtime` and your bundled generic worker URL:

```ts
import type { GuestLauncher, Runtime } from "waffle";

function genericLauncher(workerUrl: string): GuestLauncher {
  return (context, service) =>
    service.launchWorker(context, {
      workerUrl,
      request: {
        module: context.module,
        args: context.request.argv,
        env: context.request.env,
        interruptible: context.interruptible,
      },
    });
}

async function samples(runtime: Runtime, rootPid: number, directory: string) {
  const service = await runtime.processes();
  return service
    .workerMemory()
    .filter((sample) => sample.rootPid === rootPid && sample.directory === directory);
}
```

Register `genericLauncher(workerUrl)` with your existing adapter registration. Capture `directory` from `workerProcessDirectoryId` on your existing root transport. Neither the root ID nor a directory buffer's size is a memory measurement.

Each `WorkerMemoryObservation` is a fresh record with these read-only fields:

| Field                                | Meaning                                                                            |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| `pid`, `parentPid`, `rootPid`, `job` | Process identity and ancestry captured from the exact admitted transport at launch |
| `directory`                          | Opaque identity of that transport's process directory                              |
| `bytes`                              | Latest actual memory-buffer byte length, or `null` before a memory sample exists   |

`0` means an observed zero-byte memory. `null` means unknown, including custom worker entries that do not use Waffle bootstrap. A worker reservation alone does not create a memory observation. Non-worker adapter allocations and the filesystem's memory are outside this API.

## Sampling cadence and limits

Bootstrap samples the currently bound `WebAssembly.Memory` when it binds memory, before and after linked host imports, and during finish after the executor's `beforeFinish` hook. Each sample reads the memory's current buffer through captured native getters. It follows growth that replaces or grows that buffer. Existing bootstrap rules reject replacement with a different memory.

The page reads a shared atomic sample without scheduling work inside the guest worker. While a host import blocks, the page can read its entry sample. No timer is expected to run while Wasm or a synchronous host import blocks the worker event loop.

The result is a sampled allocation, not a configured maximum, an allocation limit, a peak, a heap-use measurement, resident memory, or a real-time guarantee. Memory can grow between host boundaries. During a long pure-Wasm interval, its reported size can remain stale until the next boundary or finish. The API does not measure multiple separate memories in a custom executor.

Imported memory is visible before instantiation and can be sampled even if a start section then traps. Defined memory becomes visible only when instantiation returns its exports. If instantiation fails before that point, `bytes` remains `null`, even if the engine allocated memory internally. The runtime does not fabricate a zero or infer allocation from module declarations.

## Retirement and failures

The broker owns a fresh sample cell for each worker launch and never recycles it. It captures attribution once, so collection or reuse of a process-directory slot cannot retarget a late sample. Normal process identity allocation does not reuse PIDs. Group snapshots by both directory and root identity when observing one root among several.

Logical exit, start failure, and cancellation do not remove an observation. It remains until the existing filesystem and adapter fences finish, the worker physically stops, and adapter cleanup succeeds. Failed fencing, termination, notification cleanup, or adapter cleanup retains the observation and the existing stop/disposal failure. A retained row therefore does not by itself prove a running worker. It can represent cleanup debt.

Successful disposal removes the broker's observations. As with other borrowed runtime capabilities, callers cannot use the service after runtime disposal starts. Disposal failure retains ownership internally; it does not turn the failure into successful cleanup.

`WorkerLaunchOptions.request` excludes the broker-owned `memoryObservation` channel. Direct bootstrap embeddings can provide one eight-byte shared cell initialized to `-1n`; they own attribution and physical retirement themselves. Ordinary adapters consume `workerMemory()` instead.
