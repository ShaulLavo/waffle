import { FilesystemClient } from "../../fs/client";
import type { FilesystemConnection } from "../../fs/protocol";

type Message = {
  connection: FilesystemConnection;
  control: SharedArrayBuffer;
  mode: "spawn" | "namespace" | "loop" | "global-lock";
};

function errnoOf(error: unknown): unknown {
  return typeof error === "object" && error && "errno" in error ? error.errno : String(error);
}

function spawn(client: FilesystemClient): void {
  try {
    self.postMessage({ preopen: client.call("preopen", ["/"]) });
  } catch (error) {
    self.postMessage({ preopenErrno: errnoOf(error) });
  }
}

function namespace(client: FilesystemClient, control: Int32Array): void {
  const root: number = client.call("preopen", ["/"]);
  const path: { node: number } = client.call("resolve", [root, "shared"]);
  client.retain(path.node);
  self.postMessage({ ready: true });
  while (!Atomics.load(control, 0)) Atomics.wait(control, 0, 0);
  const started = performance.now();
  const setMode = client.setMode(path.node, 0o600);
  let preopen: unknown;
  try {
    preopen = client.call("preopen", ["/"]);
  } catch (error) {
    preopen = { errno: errnoOf(error) };
  }
  const lockStillHeld = Atomics.load(control, 1) === 0;
  self.postMessage({ setMode, preopen, lockStillHeld, ms: performance.now() - started });
}

function loop(client: FilesystemClient, control: Int32Array): void {
  const root: number = client.call("preopen", ["/"]);
  const path: { node: number } = client.call("resolve", [root, "shared"]);
  client.retain(path.node);
  const chunk = new Uint8Array(16).fill(65);
  let ok = 0,
    eagain = 0,
    other = 0;
  self.postMessage({ ready: true });
  while (!Atomics.load(control, 0)) {
    const result = client.write(path.node, [chunk], 0);
    if (result > 0) ok++;
    else if (result === -6) eagain++;
    else other++;
  }
  self.postMessage({ ok, eagain, other });
}

self.onmessage = ({ data }: MessageEvent<Message>) => {
  const client = new FilesystemClient(data.connection);
  const control = new Int32Array(data.control);
  try {
    if (data.mode === "global-lock")
      client.shared.mutate(undefined, undefined, () => {
        self.postMessage({ ready: true });
        const outcome = Atomics.wait(control, 0, 0, 2000);
        Atomics.store(control, 1, outcome === "timed-out" ? 2 : 1);
      });
    if (data.mode === "spawn") spawn(client);
    if (data.mode === "namespace") namespace(client, control);
    if (data.mode === "loop") loop(client, control);
  } finally {
    client.dispose();
    self.close();
  }
};
