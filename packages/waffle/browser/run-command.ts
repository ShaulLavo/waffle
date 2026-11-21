import { allocateSharedControl } from "../memory/control.js";
import { COMMAND_TRANSFER_BYTES } from "../proc/command-transfer.js";
import { DescriptorTable } from "../core/descriptors.js";
import type { Runtime } from "../runtime.js";
import { commandDisposals, commandOwners } from "./command-owner.js";
import { controlLoad } from "../proc/control.js";
import { directoryJob } from "../proc/directory.js";
import type { PipeEndpoint } from "../proc/pipes.js";
import type { WorkerPipeHost } from "../proc/worker-pipes.js";
import { atomicsWaitAsync } from "../proc/intrinsics.js";
import { readOutcome } from "../proc/outcome.js";
import type { CommandOptions, CommandOutput, CommandOutputOptions } from "../proc/start-command.js";
import { checkedSignal, type ProcessExit, type ProcessSignal } from "../proc/types.js";
import {
  createWorkerProcessTransport,
  wakeWorkerProcess,
  WorkerProcessClient,
  workerProcessState,
  type WorkerProcessMessage,
  type WorkerProcessTransport,
  type WorkerSpawnTransfer,
} from "../proc/worker-client.js";
import type { BrowserProcessBroker } from "./process-broker.js";
import { createRuntimeTerminalCodec } from "./runtime-terminals.js";
import { CommandInput } from "./command-input.js";

const READ = 1n << 1n;
const WRITE = 1n << 6n;
const POLL = 1n << 27n;
const FD_FILESTAT_GET = 1n << 21n;
const OUTPUT_BATCH = 32;

class Capture {
  private bytes = new Uint8Array(0);
  private readonly limit: number;
  private size = 0;
  private truncated = false;
  private onChunk?: CommandOutputOptions["onChunk"];

  constructor(options: CommandOptions["stdout"]) {
    this.limit = options === "closed" ? 0 : (options?.limitBytes ?? 64 * 1024);
    this.onChunk = options === "closed" ? undefined : options?.onChunk;
  }
  append(data: Uint8Array): void {
    const length = Math.min(data.length, this.limit - this.size);
    if (length) {
      const size = this.size + length;
      if (size > this.bytes.length) this.grow(size);
      this.bytes.set(data.subarray(0, length), this.size);
      this.size = size;
    }
    if (length < data.length) this.truncated = true;
    try {
      const onChunk = this.onChunk;
      if (!onChunk) return;
      const returned: unknown = onChunk(data.slice());
      if (returned === undefined) return;
      if (returned instanceof Promise) void returned.catch(() => {});
      throw new TypeError("Command output callbacks must return undefined synchronously");
    } catch (error) {
      this.onChunk = undefined;
      throw error;
    }
  }
  private grow(size: number): void {
    const capacity = Math.min(this.limit, Math.max(size, 4096, 2 * this.bytes.length));
    const bytes = new Uint8Array(capacity);
    bytes.set(this.bytes);
    this.bytes = bytes;
  }
  result(): CommandOutput {
    const bytes = this.bytes.length === this.size ? this.bytes : this.bytes.slice(0, this.size);
    this.bytes = new Uint8Array(0);
    return { bytes, truncated: this.truncated };
  }
}

interface Leader {
  readonly job: number;
  readonly state: ReturnType<typeof directoryJob>;
}

class Command {
  private readonly stdout: Capture;
  private readonly stderr: Capture;
  private readonly descriptors = new DescriptorTable();
  private readonly leader = Promise.withResolvers<Leader | undefined>();
  private readonly abortSetup = Promise.withResolvers<undefined>();
  private readonly disposeSignal: AbortSignal;
  private root?: WorkerProcessTransport;
  private owner?: BrowserProcessBroker;
  private input?: CommandInput;
  private outputTask?: ReturnType<typeof setTimeout>;
  private outputBatch = OUTPUT_BATCH;
  private ioFailure?: { error: unknown };
  private settled = false;

  constructor(
    private readonly runtime: Runtime,
    private readonly executable: string,
    private readonly options: CommandOptions,
    private readonly stopped: AbortSignal,
  ) {
    this.stdout = new Capture(options.stdout);
    this.stderr = new Capture(options.stderr);
    let disposing = commandDisposals.get(runtime);
    if (!disposing) commandDisposals.set(runtime, (disposing = new AbortController()));
    this.disposeSignal = disposing.signal;
  }

  private readonly stop = () => {
    this.abortSetup.resolve(undefined);
    if (!this.root || this.runtime.disposed) return;
    this.stopInput();
    try {
      this.owner?.stopCommandRoot(this.root);
    } catch (error) {
      this.ioFailure ??= { error };
      wakeWorkerProcess(this.root);
    }
  };

  private readonly dispose = () => {
    this.abortSetup.resolve(undefined);
    if (this.root) wakeWorkerProcess(this.root);
    this.stopInput();
  };

  private readonly failIO = (error: unknown) => {
    this.ioFailure ??= { error };
    this.stop();
  };

  private stopInput(): void {
    void this.input?.stop().catch(this.failIO);
  }

  async signal(signal: ProcessSignal): Promise<void> {
    if (this.settled) return;
    const sig = checkedSignal(signal);
    const leader = await this.leader.promise;
    if (!leader || this.settled || this.runtime.disposed || !this.root) return;
    if (leader.state.outcome.valid() && controlLoad(leader.state.pending) > 0)
      await this.owner?.killJob(leader.job, sig);
  }

  async execute() {
    this.stopped.addEventListener("abort", this.stop, { once: true });
    this.disposeSignal.addEventListener("abort", this.dispose, { once: true });
    try {
      const exit = await this.run();
      if (this.runtime.disposed) await this.disposed();
      if (this.ioFailure) throw this.ioFailure.error;
      return { exit, stdout: this.stdout.result(), stderr: this.stderr.result() };
    } finally {
      this.settled = true;
      this.leader.resolve(undefined);
      this.stopped.removeEventListener("abort", this.stop);
      this.disposeSignal.removeEventListener("abort", this.dispose);
      clearTimeout(this.outputTask);
    }
  }

  private async disposed(): Promise<never> {
    await this.runtime.dispose();
    throw new Error("Runtime was disposed while running a command");
  }

  private async run(): Promise<ProcessExit | null> {
    if (this.runtime.disposed) return this.disposed();
    if (this.stopped.aborted) return null;
    const service = await Promise.race([this.runtime.processes(), this.abortSetup.promise]);
    if (this.runtime.disposed) return this.disposed();
    if (!service || this.stopped.aborted) return null;
    const owner = commandOwners.get(service);
    if (!owner) throw new Error("Process service has no command owner");
    await Promise.race([owner.ready(), this.abortSetup.promise]);
    if (this.runtime.disposed) return this.disposed();
    if (this.stopped.aborted) return null;
    return this.runInRoot(owner);
  }

  private async runInRoot(owner: BrowserProcessBroker): Promise<ProcessExit | null> {
    const root = {
      ...createWorkerProcessTransport({
        identity: this.runtime.identities.buffer,
        foreground: false,
      }),
      commandTransfer: allocateSharedControl(COMMAND_TRANSFER_BYTES),
    };
    const filesystem = this.runtime.filesystem.createIdentity();
    this.owner = owner;
    this.root = root;
    let adopted = false;
    let leader: Leader | undefined;
    try {
      await owner.adoptCommandRoot(root, {
        filesystem,
        memory: [],
        tryOutput: (fd, bytes) => this.deliver(fd, bytes),
        stop: () => this.input?.stop(),
      });
      adopted = true;
      if (this.runtime.disposed) return this.disposed();
      if (!this.stopped.aborted) leader = this.spawn(owner, root);
    } catch (error) {
      if (this.runtime.disposed) return this.disposed();
      if (!adopted) {
        this.runtime.filesystem.revoke(filesystem);
        this.runtime.filesystem.reap(filesystem);
        throw error;
      }
      this.failIO(error);
    } finally {
      try {
        this.descriptors.dispose();
      } catch (error) {
        this.failIO(error);
      }
      this.leader.resolve(leader);
    }
    if (this.stopped.aborted || this.ioFailure) this.stop();
    try {
      const result = await this.join(owner, root, leader);
      if (this.runtime.disposed) return this.disposed();
      await this.input?.stop();
      await owner.retireCommandRoot(root);
      return result;
    } catch (error) {
      if (this.runtime.disposed) return this.disposed();
      owner.stopCommandRoot(root);
      throw error;
    } finally {
      await this.input?.stop();
    }
  }

  private spawn(owner: BrowserProcessBroker, root: WorkerProcessTransport): Leader {
    let leader: Leader | undefined;
    let writer: PipeEndpoint | undefined;
    const post = (message: WorkerProcessMessage) => {
      if (message.operation === "spawn") {
        const { job, jobSlot } = workerProcessState(message.transport);
        leader = { job, state: directoryJob(root.directory, jobSlot, job) };
      }
      void owner.runtimeMessage(message, root.pid).catch((error) => {
        if (message.operation !== "spawn") this.failIO(error);
      });
    };
    const pipes = owner.commandPipeHost(root, post);
    const stdin = this.options.stdin;
    try {
      if (stdin !== undefined && stdin !== "closed") {
        const [reader, input] = pipes.createPipe();
        writer = input;
        this.descriptors.openAt(0, reader, READ | POLL | FD_FILESTAT_GET, 0n);
      }
      this.openTerminals(stdin);
      const codec = createRuntimeTerminalCodec({
        descriptors: this.descriptors,
        fallback: pipes.codec(),
      });
      const client = new WorkerProcessClient({
        transport: root,
        descriptors: this.descriptors,
        codec,
        postMessage: post,
        prepareSpawn: (pid, cleanupFailed) => this.prepareChild(pipes, pid, cleanupFailed),
      });
      client.spawn(root.pid, {
        executable: this.executable,
        argv: [this.executable].concat(this.options.args ?? []),
        env: { ...this.options.env },
        cwd: this.options.cwd ?? "/",
        job: -1,
        jobLifetime: "caller-fatal",
        fds: this.descriptors.inheritable().map((fd) => ({ parent: fd, child: fd })),
      });
      if (writer && stdin !== undefined && stdin !== "closed")
        this.input = new CommandInput(writer, stdin, this.failIO);
    } catch (error) {
      writer?.close();
      if (!leader) throw error;
      this.failIO(error);
    }
    if (!leader) throw new Error("Command leader was not published");
    return leader;
  }

  private prepareChild(
    pipes: WorkerPipeHost,
    pid: number,
    cleanupFailed?: (error: unknown) => void,
  ): WorkerSpawnTransfer {
    const filesystem = this.runtime.filesystem.createIdentity();
    let enrolled = false;
    const cancel = () => {
      this.runtime.filesystem.revoke(filesystem);
      this.runtime.filesystem.reap(filesystem);
      if (enrolled) pipes.registry.collectProcess(pid);
    };
    try {
      pipes.registry.registerProcess(pid);
      enrolled = true;
      return { data: { filesystem, pipeRegistry: pipes.registry.handle() }, cancel };
    } catch (error) {
      try {
        cancel();
      } catch (cleanup) {
        cleanupFailed?.(cleanup);
      }
      throw error;
    }
  }

  private openTerminals(stdin: CommandOptions["stdin"]): void {
    for (const fd of [0, 1, 2] as const) {
      if (
        (fd === 0 && stdin !== undefined) ||
        (fd === 1 && this.options.stdout === "closed") ||
        (fd === 2 && this.options.stderr === "closed")
      )
        continue;
      this.descriptors.openAt(
        fd,
        {
          kind: "terminal",
          read: () => 0,
          write: () => 0,
          readiness: () => ({ readable: fd === 0, writable: fd !== 0, hangup: fd === 0 }),
        },
        (fd === 0 ? READ : WRITE) | POLL | FD_FILESTAT_GET,
        0n,
      );
    }
  }

  private deliver(fd: 1 | 2, bytes: Uint8Array): number {
    if (this.outputBatch === 0) {
      this.outputTask ??= setTimeout(() => {
        this.outputTask = undefined;
        this.outputBatch = OUTPUT_BATCH;
        if (!this.root || this.runtime.disposed) return;
        this.owner?.outputDrained(this.root.pid);
        wakeWorkerProcess(this.root);
      }, 0);
      return 0;
    }
    this.outputBatch--;
    if (this.settled) return bytes.length;
    try {
      (fd === 1 ? this.stdout : this.stderr).append(bytes);
    } catch (error) {
      this.failIO(error);
    }
    return bytes.length;
  }

  private async join(owner: BrowserProcessBroker, root: WorkerProcessTransport, leader?: Leader) {
    const wake = workerProcessState(root).wake;
    let exit: ProcessExit | null = null;
    for (;;) {
      const expected = Atomics.load(wake, 0);
      if (this.runtime.disposed) return this.disposed();
      if (this.stopped.aborted || this.ioFailure) this.stopInput();
      if (leader && !exit) exit = readOutcome(leader.state.outcome);
      if (owner.checkCommandCleanup(root, !leader || exit !== null)) {
        if (!leader || exit) return exit;
        throw new Error("Command leader retired without an outcome");
      }
      await atomicsWaitAsync(wake, 0, expected).value;
    }
  }
}

export function runCommand(
  runtime: Runtime,
  executable: string,
  options: CommandOptions,
  stopped: AbortSignal,
) {
  const command = new Command(runtime, executable, options, stopped);
  return {
    result: command.execute(),
    signal: (signal: ProcessSignal) => command.signal(signal),
  };
}
