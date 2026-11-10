import { FilesystemClient } from "../../fs/client.js";
import type { FilesystemConnection } from "../../fs/protocol.js";
import {
  enumerateDirectory,
  linkLifecycle,
  metadataGuest,
} from "./metadata-enumeration-r173-wasi.js";

type Input = { connection: FilesystemConnection; peer: FilesystemConnection } & (
  | { scenario: "links"; root: string }
  | { scenario: "directory"; count: number; capacity?: number }
  | { scenario: "reload" }
  | { scenario: "delete"; count: number }
);

function reload(fs: FilesystemClient) {
  const h = metadataGuest(fs);
  try {
    const fd = h.open("file");
    const linked = h.stat("file");
    const alias = h.stat("alias");
    h.unlink("alias");
    const remaining = h.stat("file");
    h.unlink("file");
    const detached = h.fstat(fd);
    return { linked, alias, remaining, detached };
  } finally {
    h.wasi.descriptors.dispose();
  }
}

function deleteFiles(fs: FilesystemClient, count: number) {
  const h = metadataGuest(fs);
  try {
    for (let index = 0; index < count; index++) h.unlink(`entry-${index}`);
    return { removed: count };
  } finally {
    h.wasi.descriptors.dispose();
  }
}

function runScenario(fs: FilesystemClient, input: Input) {
  if (input.scenario === "directory") return enumerateDirectory(fs, input.count, input.capacity);
  if (input.scenario === "reload") return reload(fs);
  if (input.scenario === "delete") return deleteFiles(fs, input.count);
  const peer = new FilesystemClient(input.peer);
  const observer = metadataGuest(peer, input.root);
  try {
    return linkLifecycle(fs, input.root, observer);
  } finally {
    observer.wasi.descriptors.dispose();
    peer.dispose();
  }
}

self.onmessage = (event: MessageEvent<Input>) => {
  const fs = new FilesystemClient(event.data.connection);
  let result: ReturnType<typeof runScenario> | { error: string | undefined };
  try {
    result = runScenario(fs, event.data);
  } catch (error) {
    result = { error: error instanceof Error ? error.stack : String(error) };
  } finally {
    fs.dispose();
    event.data.peer.port.close();
  }
  self.postMessage(result);
};
