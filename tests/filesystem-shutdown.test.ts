import { expect, test } from "bun:test";
import { createFilesystemConnection, FilesystemService, MemoryBackend } from "../fs";
import { FilesystemSection } from "../fs/protocol";

class ClosingBackend extends MemoryBackend {
  closes = 0;
  close(): Promise<void> {
    this.closes++;
    return Promise.resolve();
  }
}

async function checkpoint(): Promise<void> {
  const channel = new MessageChannel();
  try {
    await new Promise<void>((resolve) => {
      channel.port1.onmessage = () => resolve();
      channel.port2.postMessage(null);
    });
  } finally {
    channel.port1.close();
    channel.port2.close();
  }
}

test("shutdown joins the original section before backend close", async () => {
  const backend = new ClosingBackend();
  const service = new FilesystemService(backend);
  const pair = createFilesystemConnection();
  const section = new FilesystemSection(pair.client);
  let held = false;
  let stopping: Promise<void> | undefined;
  try {
    service.connect(pair.server);
    section.enter();
    held = true;
    stopping = service.shutdown();
    await checkpoint();
    expect(backend.closes).toBe(0);
  } finally {
    if (held) section.exit();
    try {
      await stopping;
    } finally {
      pair.client.port.close();
      pair.server.port.close();
      service.dispose();
    }
  }
  expect(backend.closes).toBe(1);
});
