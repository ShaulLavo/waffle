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

self.onmessage = (event: MessageEvent<Input>) => {
  const fs = new FilesystemClient(event.data.connection);
  try {
    if (event.data.scenario === "directory") {
      self.postMessage(enumerateDirectory(fs, event.data.count, event.data.capacity));
      return;
    }
    if (event.data.scenario === "reload") {
      self.postMessage(reload(fs));
      return;
    }
    if (event.data.scenario === "delete") {
      self.postMessage(deleteFiles(fs, event.data.count));
      return;
    }
    const peer = new FilesystemClient(event.data.peer);
    const observer = metadataGuest(peer, event.data.root);
    try {
      self.postMessage(linkLifecycle(fs, event.data.root, observer));
    } finally {
      observer.wasi.descriptors.dispose();
      peer.dispose();
    }
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.stack : String(error) });
  } finally {
    fs.dispose();
    event.data.peer.port.close();
  }
};
