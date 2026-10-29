import { afterEach, expect, test } from "bun:test";
import {
  FilesystemClient,
  connectFilesystemIdentity,
  createFilesystemConnection,
  createProcessFilesystemIdentity,
  sharedRevoked,
} from "../fs";
import { SharedFilesystem } from "../browser/shared-fs";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture() {
  const root = createFilesystemConnection();
  const client = new FilesystemClient(root.client);
  let terminated = 0;
  // Exercise the actual page-side failure handler without starting a browser worker.
  const fs = Object.assign(Object.create(SharedFilesystem.prototype), {
    client,
    worker: {
      terminate() {
        terminated++;
      },
    },
    writes: Promise.resolve(),
    socketAttachments: new Set(),
    _state: { status: "opening" },
  }) as unknown as { fail(error: Error): void; dispose(): void };
  cleanups.push(() => {
    client.dispose();
    root.server.port.close();
  });
  return { fs, client, terminated: () => terminated };
}
function processClient(parent: FilesystemClient) {
  const connection = connectFilesystemIdentity(createProcessFilesystemIdentity(parent.connection));
  const client = new FilesystemClient(connection.client);
  cleanups.push(() => {
    client.dispose();
    connection.server.port.close();
  });
  return client;
}

test("filesystem worker failure revokes independent process identities and pending completions", async () => {
  const { fs, client, terminated } = fixture();
  const child = processClient(client);
  const grandchild = processClient(child);
  const completions = [child.submit("stat", [0]), grandchild.submit("stat", [0])];
  cleanups.push(() => {
    for (const completion of completions) completion.release();
  });
  const failures = completions.map((completion) => completion.value().catch((error) => error));
  fs.fail(new Error("storage worker crashed"));
  expect(terminated()).toBe(1);
  expect(sharedRevoked(child.connection)()).toBe(true);
  expect(sharedRevoked(grandchild.connection)()).toBe(true);
  expect(await Promise.all(failures)).toEqual([
    expect.objectContaining({ errno: 11 }),
    expect.objectContaining({ errno: 11 }),
  ]);
});

test("disposing the filesystem service revokes process identities allocated but not yet connected", () => {
  const { fs, client } = fixture();
  const pending = createProcessFilesystemIdentity(client.connection);
  expect(sharedRevoked(pending)()).toBe(false);
  fs.dispose();
  expect(sharedRevoked(pending)()).toBe(true);
});
