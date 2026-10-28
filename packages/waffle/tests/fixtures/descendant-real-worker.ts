import { bootstrap, type RuntimeWorkerRequest } from "../../browser/worker.js";
import {
  attachTerminal,
  claimTerminalAuthority,
  createTerminalInputPolicy,
  type TerminalAttachment,
  type TerminalIdentity,
} from "../../browser/runtime-terminals.js";
import { workerProcessState, type WorkerProcessTransport } from "../../proc/worker-client.js";
import { guestFunction } from "./publication-wasm.js";

export interface DescendantWorkerRequest extends RuntimeWorkerRequest {
  runtimeProcess: WorkerProcessTransport;
  markers: Int32Array;
  terminalIdentity: TerminalIdentity;
}

async function execute(request: DescendantWorkerRequest) {
  const role = request.args[0];
  const marker = role === "child" ? 0 : role === "grandchild" ? 1 : role === "probe" ? 2 : 3;
  const state = workerProcessState(request.runtimeProcess);
  let terminal: TerminalAttachment | undefined;
  let input: SharedArrayBuffer | undefined;
  const post = (event: string, data: Record<string, unknown> = {}) =>
    globalThis.postMessage({ type: "descendant-fixture", event, pid: state.pid, ...data });
  await bootstrap(
    request,
    {
      setup(context) {
        // This input-only fixture never sends a filesystem request to a service.
        context.fs.preopen = () => 1;
        context.fs.retain = () => {};
        context.fs.release = () => {};
        const data = request.runtimeProcess.data;
        if (typeof data !== "object" || data === null || !("terminalContext" in data))
          throw new Error("missing inherited context");
        if (!("terminalInput" in data) || !(data.terminalInput instanceof SharedArrayBuffer))
          throw new Error("missing inherited input");
        input = data.terminalInput;
        const policy = createTerminalInputPolicy({ input: data.terminalInput });
        const claim = claimTerminalAuthority({
          identity: request.terminalIdentity,
          process: request.runtimeProcess,
          checkActive: context.checkActive,
          policy,
        });
        terminal = attachTerminal({
          context: data.terminalContext,
          process: request.runtimeProcess,
          checkActive: context.checkActive,
          policy,
        });
        const ready = terminal.ready();
        if (ready.kind === "error") throw new Error(ready.code);
        post("ready", { claim, inherited: terminal.inherit(), job: state.job });
      },
      namespaces: () => ({
        descendant_fixture: {
          guest_start() {
            Atomics.add(request.markers, marker, 1);
          },
        },
      }),
      resolveTerminal: (target) => (target === 0 ? terminal?.resolve(0) : undefined),
      spawnData() {
        if (!terminal || !input) throw new Error("terminal setup did not run");
        return { terminalContext: terminal.inherit(), terminalInput: input };
      },
      instantiated() {
        if (role !== "race") return;
        post("entry-barrier");
        if (Atomics.wait(request.markers, 5, 0, 5000) === "timed-out")
          throw new Error("entry barrier timeout");
        Atomics.store(request.markers, 6, 1);
      },
      beforeFinish() {
        terminal?.dispose();
        if (role !== "race") return;
        Atomics.add(request.markers, 7, 1);
        post("fenced");
      },
      run({ instance, process }) {
        if (!(instance.exports.memory instanceof WebAssembly.Memory))
          throw new Error("missing memory");
        const memory = instance.exports.memory;
        if (role === "child") {
          const spec = new TextEncoder().encode(
            JSON.stringify({
              executable: "grandchild",
              argv: ["grandchild"],
              env: {},
              cwd: "/",
              job: state.job,
              fds: [{ parent: 0, child: 0 }],
            }),
          );
          new Uint8Array(memory.buffer).set(spec, 256);
          const pid = process!.imports.spawn!(256, spec.length);
          if (pid <= 0) throw new Error(`spawn failed: ${pid}`);
          post("spawned", { child: pid });
          if (Atomics.wait(request.markers, 4, 0, 5000) === "timed-out")
            throw new Error("child release timeout");
          return 0;
        }
        if (role !== "grandchild") return 0;
        const view = new DataView(memory.buffer);
        view.setUint32(0, 16, true);
        view.setUint32(4, 1, true);
        const errno = guestFunction(instance, "fd_read")(0, 0, 1, 8);
        post("read", { errno, count: view.getUint32(8, true), byte: view.getUint8(16) });
        return errno;
      },
    },
    { crossOriginIsolated: true, postMessage: (message) => globalThis.postMessage(message) },
  );
}

globalThis.onmessage = ({ data }: MessageEvent<DescendantWorkerRequest>) => {
  globalThis.onmessage = null;
  void execute(data);
};
