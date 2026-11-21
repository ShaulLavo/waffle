import type { DescriptorTable } from "../core/descriptors.js";
import { RIGHTS_ALL } from "../core/rights.js";
import { FilesystemClient } from "../fs/client.js";
import type { FilesystemIdentity } from "../fs/protocol.js";
import { createFilesystemDescriptorCodec } from "../proc/filesystem-codec.js";
import type { PipeEndpoint } from "../proc/pipes.js";
import type { ThreadServiceEvent } from "../thread/runtime-protocol.js";
import type { createThreadRuntime } from "./threads-runtime-host.js";
import type { FdServiceEvent } from "./threads-runtime-fd-service.js";
import { fdLayout, type DescriptorCase } from "./threads-runtime-fd-module.js";
import {
  check,
  until,
  type ThreadRegressionObservations,
} from "./threads-runtime-regression-controls.js";

function same(actual: unknown, expected: unknown, label = "descriptor evidence"): void {
  check(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
  );
}

type FsEvent =
  | { kind: "fd-held"; operation: string; args: unknown[] }
  | { kind: "fd-released" | "fd-armed" };

export class RuntimeDescriptorCase {
  readonly host: NonNullable<Parameters<typeof createThreadRuntime>[2]>;
  private readonly events: (FdServiceEvent | FsEvent | ThreadServiceEvent)[] = [];
  private filesystemWorker: Worker | undefined;
  private files: FilesystemClient | undefined;
  private originalHandle: number | undefined;
  private connect: ((identity: FilesystemIdentity) => FilesystemClient) | undefined;
  private released = false;
  private serviceInitializations = 0;

  constructor(
    readonly selected: DescriptorCase,
    local: boolean,
  ) {
    this.host = {
      workerURL: local
        ? new URL("./threads-runtime-fd-filesystem.ts", import.meta.url)
        : "/thread-fd-filesystem.js",
      connect: (filesystem) => {
        this.connect = (identity) => new FilesystemClient(filesystem.connect(identity));
      },
    };
  }

  observe(worker: Worker, target: string): void {
    if (!/fd-filesystem|fd-service/.test(target)) return;
    if (target.includes("fd-filesystem")) this.filesystemWorker = worker;
    worker.addEventListener(
      "message",
      ({ data }: MessageEvent<FdServiceEvent | FsEvent | ThreadServiceEvent>) => {
        this.events.push(data);
      },
    );
  }

  observePost(message: unknown): void {
    if (!message || typeof message !== "object" || !("kind" in message)) return;
    if (message.kind !== "thread-service") return;
    if (!("memory" in message) || !(message.memory instanceof WebAssembly.Memory)) return;
    this.serviceInitializations++;
    same(this.serviceInitializations, 1, "canonical descriptor service initialization");
  }

  async setup(
    runtime: ReturnType<typeof createThreadRuntime>,
    descriptors: DescriptorTable,
    identity: FilesystemIdentity,
  ): Promise<void> {
    await runtime.filesystem.writeFile("/original", "ABCDEFGHIJ");
    await runtime.filesystem.writeFile("/replacement", "1234567890");
    check(this.connect, "descriptor filesystem connection");
    const files = (this.files = this.connect(identity));
    const preopen = await files.asyncCall("preopen", ["/"]);
    for (const [fd, name] of [
      [4, "original"],
      [5, "replacement"],
    ] as const) {
      const { node: handle } = await files.asyncCall("resolve", [preopen, name]);
      if (fd === 4) this.originalHandle = handle;
      files.retain(handle);
      descriptors.openAt(
        fd,
        { kind: "file", handle, offset: 0, append: false },
        RIGHTS_ALL,
        RIGHTS_ALL,
        () => files.release(handle),
      );
    }
  }

  codec(target: FilesystemIdentity) {
    check(this.files, "descriptor filesystem client");
    return createFilesystemDescriptorCodec(this.files, target);
  }

  async arm(): Promise<void> {
    check(this.filesystemWorker, "descriptor filesystem Worker");
    this.filesystemWorker.postMessage({ kind: "fd-arm", selected: this.selected });
    await until(() => this.events.some((event) => event.kind === "fd-armed"), "filesystem arm");
  }

  release(): void {
    if (this.released || !this.filesystemWorker) return;
    this.filesystemWorker.postMessage({ kind: "fd-release" });
    this.released = true;
  }

  dispose(): void {
    this.files?.dispose();
  }

  async run(input: {
    runtime: ReturnType<typeof createThreadRuntime>;
    memory: WebAssembly.Memory;
    inputWriter: PipeEndpoint;
    pid: number;
    observations: ThreadRegressionObservations;
    readOutput: () => string;
  }) {
    const { runtime, memory, inputWriter, pid, observations, readOutput } = input;
    const proof = await this.exercise(memory, inputWriter, readOutput);
    observations.signal(fdLayout.childRelease);
    await until(() => observations.retired(2), "descriptor sibling retired before main");
    check(
      observations.guests.size === 2 &&
        [1, 2].every(
          (tid) =>
            observations.guests.get(tid)?.request.thread.pid === pid &&
            observations.event(tid, "ready"),
        ),
      "descriptor lanes belong to the same PID",
    );
    observations.signal(fdLayout.mainRelease);
    return { ...proof, ...(await this.checkFiles(runtime)) };
  }

  private async exercise(
    memory: WebAssembly.Memory,
    inputWriter: PipeEndpoint,
    readOutput: () => string,
  ) {
    const p = fdLayout;
    const view = new DataView(memory.buffer);
    const count = (address: number) => view.getUint32(address, true);
    const cursor = (address: number) => Number(view.getBigUint64(address, true));
    const text = (address: number, length: number) =>
      String.fromCharCode(...new Uint8Array(memory.buffer, address, length));
    const flags = (index: number) => {
      const address = p.status[index]!;
      same(view.getUint8(address), 4);
      return view.getUint16(address + 2, true);
    };
    await until(() => this.events.some((event) => event.kind === "fd-held"), "file operation held");
    const heldEvent = this.events.find((event) => event.kind === "fd-held");
    same(heldEvent?.operation, this.selected);
    same(
      heldEvent?.args,
      this.selected === "read" ? [this.originalHandle, 2, 0] : [this.originalHandle, 0],
    );
    same(
      [
        text(288, 2),
        cursor(272),
        text(352, 2),
        cursor(336),
        cursor(344),
        count(648),
        cursor(656),
        text(416, 2),
        cursor(400),
        cursor(408),
      ],
      ["AB", 2, "CD", 4, 5, 2, 7, "HI", 9, 0],
    );
    same([count(264), count(328), count(392)], [2, 2, 2]);
    same([flags(0), flags(1), flags(2)], [0, 4, 4]);

    const original = () => this.completed(this.selected, 4, p.held + 32);
    same(original().length, 0);
    same(inputWriter.tryWrite([new Uint8Array([90])]), 1);
    await until(() => this.completed("write", 1, 992).length === 1, "sibling descriptor reuse");
    await until(() => readOutput().length >= 2, "sibling pipe output before releasing file I/O");
    same(readOutput(), "PR", "pipe output while the original file operation is in flight");
    same(original().length, 0, "original operation remains in flight after descriptor reuse");
    const beforeRelease = this.completed("tell", 4).at(-1)?.original;
    same([beforeRelease?.references, beforeRelease?.offset], [1, 0], "original pin before release");
    same(
      [count(776), text(800, 1), text(544, 2), cursor(528), cursor(912), count(456)],
      [1, "Z", "12", 0, 3, 0],
    );
    same(flags(3), 0);

    this.release();
    await until(() => this.completed("write", 1, 736).length === 1, "old operation completed");
    same(original().length, 1);
    const originalCompletion = original()[0];
    const result = originalCompletion?.result;
    check(result?.kind === "ok" && result.value === 2, "original call completed for two bytes");
    same(
      [originalCompletion?.original?.references, originalCompletion?.original?.offset],
      [0, 2],
      "old cursor after completing its last reference",
    );
    same(
      [count(456), text(480, 2), cursor(464), text(608, 1), count(584), cursor(592), flags(4)],
      [2, this.selected === "read" ? "AB" : "UV", 3, "4", 1, 4, 0],
    );
    return { beforeRelease, originalCompletion, flags: p.status.map((_, index) => flags(index)) };
  }

  private async checkFiles(runtime: ReturnType<typeof createThreadRuntime>) {
    const contents = async (name: string) =>
      new TextDecoder().decode(await runtime.filesystem.readFile(name));
    const originalBytes = await contents("/original");
    const replacementBytes = await contents("/replacement");
    same(originalBytes, this.selected === "read" ? "ABCDExyHIJ" : "UVCDExyHIJ");
    same(replacementBytes, "12Q4567890");
    return { originalBytes, replacementBytes };
  }

  checkDisposal() {
    const drained = this.events.filter((event) => event.kind === "drained").length;
    const disposed = this.events.filter((event) => event.kind === "disposed").length;
    same(drained, 1);
    same(disposed, 1);
    same(this.serviceInitializations, 1, "canonical descriptor service initialization");
    return { drained, disposed };
  }

  private completed(kind: string, fd: number, address?: number) {
    return this.events.filter(
      (event): event is Extract<FdServiceEvent, { kind: "fd-completed" }> =>
        event.kind === "fd-completed" &&
        event.request.kind === kind &&
        event.request.fd === fd &&
        (address === undefined ||
          ("spans" in event.request && event.request.spans[0]?.address === address)),
    );
  }
}
