import { Wasi } from "../core/wasi.ts";
import { RIGHTS_ALL } from "../core/rights.ts";
import { ThreadService } from "../thread/service.ts";
import { FilesystemClient } from "../fs/client.ts";
import { createFilesystemConnection } from "../fs/protocol.ts";
import { PipeController } from "../proc/pipes.ts";
import type { HostCommand, HostEvent } from "./threads-service-host.ts";

export async function serviceFixture(mode: "cold" | "growth" | "dirty" = "cold") {
  const pair = createFilesystemConnection();
  const worker = new Worker(new URL("./threads-service-host.ts", import.meta.url).href);
  const events: HostEvent[] = [];
  const waits = new Map<HostEvent["kind"], ReturnType<typeof Promise.withResolvers<void>>>();
  const send = (command: HostCommand, transfer: Transferable[] = []) =>
    worker.postMessage(command, transfer);
  const event = (kind: HostEvent["kind"]) => {
    if (events.some((event) => event.kind === kind)) return Promise.resolve();
    const wait = Promise.withResolvers<void>();
    waits.set(kind, wait);
    return wait.promise;
  };
  worker.onmessage = ({ data }: MessageEvent<HostEvent>) => {
    events.push(data);
    if (data.kind === "error")
      for (const wait of waits.values()) wait.reject(new Error(data.message));
    waits.get(data.kind)?.resolve();
  };
  worker.onerror = (error) => {
    for (const wait of waits.values()) wait.reject(new Error(error.message));
  };
  const pipe = new PipeController({ relay: "manual" });
  const reader = pipe.retain(2, "read");
  const client = new FilesystemClient(pair.client);
  const wasi = new Wasi({
    args: [],
    env: {},
    fs: client,
    preopens: {},
    stdout() {},
    stderr() {},
    sleep() {},
  });
  const descriptors = wasi.descriptors;
  let service: ThreadService | undefined;
  const dispose = async () => {
    send({ kind: "release" });
    const errors: unknown[] = [];
    try {
      service?.cancelAll();
      await service?.drain();
    } catch (error) {
      errors.push(error);
    }
    try {
      descriptors.dispose();
      client.dispose();
      send({ kind: "stop" });
      await event("stopped");
    } catch (error) {
      errors.push(error);
    } finally {
      reader.close();
      pipe.dispose();
      worker.terminate();
      pair.client.port.close();
      pair.server.port.close();
    }
    if (errors.length) throw new AggregateError(errors, "thread fixture teardown failed");
  };
  try {
    send({ kind: "start", connection: pair.server, mode }, [pair.server.port]);
    await event("ready");
    const root: number = await client.asyncCall("preopen", ["/"]);
    const { node: handle }: { node: number } = await client.asyncCall("resolve", [root, "file"]);
    client.retain(handle);
    const resource = { kind: "file" as const, handle, offset: 0, append: false };
    const fd = descriptors.open(resource, RIGHTS_ALL, RIGHTS_ALL, () => client.release(handle));
    const writerFd = descriptors.open(pipe.retain(1, "write"), RIGHTS_ALL, RIGHTS_ALL);
    const memory = new WebAssembly.Memory({ initial: 2, maximum: 2, shared: true });
    service = new ThreadService({
      directory: "test",
      pid: 1,
      memory,
      filesystem: client,
      descriptors,
    });
    let sequence = 0;
    const call = (tid = 1) => ({
      thread: { directory: "test", pid: 1, tid },
      sequence: ++sequence,
    });
    return {
      client,
      wasi,
      descriptors,
      resource,
      fd,
      memory,
      service,
      call,
      dispose,
      event,
      send,
      events,
      writerFd,
      reader,
      pair,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
