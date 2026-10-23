import { expect, test } from "bun:test";
import { MemoryBackend, type FilesystemBackend } from "../fs/backend";
import { FilesystemClient } from "../fs/client";
import { createFilesystemConnection } from "../fs/protocol";
import { FilesystemService } from "../fs/service";

test("readonly preopen reaches a generic backend without mutation admission", async () => {
  const backend = new MemoryBackend();
  const calls: string[] = [];
  const delegate: FilesystemBackend = {
    execute(operation, args, input) {
      calls.push(operation);
      return backend.execute(operation, args, input);
    },
    retain: backend.retain.bind(backend),
    release: backend.release.bind(backend),
  };
  const service = new FilesystemService(delegate);
  const pair = createFilesystemConnection();
  service.connect(pair.server);
  const client = new FilesystemClient(pair.client);
  const lease = backend.shared.writeAdmission.close();
  try {
    const result = await client.asyncCall("preopen", ["/"]).catch((error: unknown) => error);
    expect(result).toBe(0);
    expect(calls).toEqual(["preopen"]);
    expect(backend.shared.writeAdmission.active).toBe(0);
    expect(backend.shared.writeAdmission.closed).toBe(true);
  } finally {
    backend.shared.writeAdmission.open(lease);
    client.dispose();
    service.dispose();
  }
});

test("readonly backend preopen never creates a missing directory", () => {
  const backend = new MemoryBackend();
  expect(() => backend.execute("preopen", ["/absent", true], new Uint8Array())).toThrow(
    expect.objectContaining({ errno: 44 }),
  );
  expect(backend.fs.lookup("/absent")).toBeUndefined();
  expect(backend.shared.writeAdmission.active).toBe(0);
});
