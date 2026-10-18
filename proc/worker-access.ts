import { executableAccessResult, MAX_ACCESS_REQUESTS } from "./access.js";
import { readOutcome } from "./outcome.js";
import { ProcessErrno, ProcessError } from "./types.js";
import {
  wakeWorkerProcess,
  workerProcessDirectoryId,
  workerProcessState,
  type WorkerProcessMessage,
  type WorkerProcessTransport,
} from "./worker-client.js";

type AccessMessage = Extract<WorkerProcessMessage, { operation: "access" | "access-cancel" }>;
interface Request {
  cells: Int32Array;
  directory: string;
  cancel?: () => void;
}

/** Authenticated transport queries share retirement and publication rules across hosts.
 * The caller authenticates the sender before entry; checks never compile or launch a guest. */
export class WorkerExecutableAccess {
  private owners?: Map<number, Map<number, Request>>;
  constructor(
    private readonly options: {
      active(sender: WorkerProcessTransport): boolean;
      check(
        sender: WorkerProcessTransport,
        path: string,
        cwd: string,
        active: () => void,
        onCancel: (cancel: () => void) => void,
      ): Promise<number>;
    },
  ) {}
  revoke(pid: number, directory?: string): void {
    const requests = this.owners?.get(pid);
    if (!requests) return;
    for (const [id, request] of requests)
      if (directory === undefined || directory === request.directory) {
        Atomics.store(request.cells, 0, 2);
        requests.delete(id);
        request.cancel?.();
      }
    if (!requests.size) this.owners!.delete(pid);
  }
  dispose(): void {
    for (const pid of this.owners?.keys() ?? []) this.revoke(pid);
  }
  async handle(message: AccessMessage, sender: WorkerProcessTransport): Promise<void> {
    const { id, completion } = message.request;
    if (
      !Number.isInteger(id) ||
      id < 1 ||
      id > 0x7fffffff ||
      !(completion instanceof SharedArrayBuffer) ||
      completion.byteLength !== 8
    )
      return;
    const cells = new Int32Array(completion),
      state = workerProcessState(sender),
      directory = workerProcessDirectoryId(sender);
    let requests = this.owners?.get(state.pid);
    if (message.operation === "access-cancel") {
      const request = requests?.get(id);
      // Structured-clone SAB wrappers differ: ownership is caller/directory/id.
      if (request?.directory === directory) {
        Atomics.store(request.cells, 0, 2);
        requests!.delete(id);
        request.cancel?.();
        if (!requests!.size) this.owners!.delete(state.pid);
      }
      return;
    }
    if (Atomics.load(cells, 0) !== 0) return;
    const publish = (result: number) => {
      Atomics.store(cells, 1, result);
      if (Atomics.compareExchange(cells, 0, 0, 1) === 0) wakeWorkerProcess(sender);
    };
    if (requests?.has(id)) return;
    if ((requests?.size ?? 0) >= MAX_ACCESS_REQUESTS) {
      publish(-ProcessErrno.AGAIN);
      return;
    }
    if (
      !message.path ||
      message.path.includes("\0") ||
      !message.cwd.startsWith("/") ||
      message.cwd.includes("\0")
    ) {
      publish(-ProcessErrno.INVAL);
      return;
    }
    if (!requests) (this.owners ??= new Map()).set(state.pid, (requests = new Map()));
    const request: Request = { cells, directory };
    requests.set(id, request);
    const active = () => {
      if (
        requests!.get(id) !== request ||
        Atomics.load(cells, 0) !== 0 ||
        readOutcome(state.signals.outcome) ||
        !this.options.active(sender)
      ) {
        throw new ProcessError(ProcessErrno.SRCH, "querying process has exited or cancelled");
      }
    };
    let result = 0;
    try {
      active();
      result = await this.options.check(sender, message.path, message.cwd, active, (cancel) => {
        request.cancel = cancel;
      });
      active();
    } catch (error) {
      result = executableAccessResult(error);
    }
    if (requests.get(id) === request) {
      requests.delete(id);
      if (!requests.size) this.owners!.delete(state.pid);
      if (!readOutcome(state.signals.outcome) && this.options.active(sender)) publish(result);
      else {
        Atomics.store(cells, 0, 2);
        request.cancel?.();
      }
    }
  }
}

export function rejectWorkerAccess(message: AccessMessage): void {
  const completion = message.request.completion;
  if (!(completion instanceof SharedArrayBuffer) || completion.byteLength !== 8) return;
  const cells = new Int32Array(completion);
  if (Atomics.load(cells, 0) !== 0) return;
  Atomics.store(cells, 1, -ProcessErrno.SRCH);
  if (Atomics.compareExchange(cells, 0, 0, 1) === 0) wakeWorkerProcess(message.transport);
}
