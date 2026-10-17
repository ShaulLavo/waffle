import { expect, test } from "bun:test";
import { createFilesystemConnection } from "../../runtime/fs";
import { SharedFilesystem } from "../src/shared-fs";

test("page cancellation is not proof of worker death; only an exit acknowledgement reaps", () => {
  const connection = createFilesystemConnection();
  let sweeps = 0;
  const filesystem = Object.create(SharedFilesystem.prototype) as SharedFilesystem;
  Object.defineProperty(filesystem, "client", { value: { sweep() { sweeps++; } } });
  try {
    filesystem.revoke(connection.client);
    expect(Atomics.load(new Int32Array(connection.client.revocations[0]!), 0)).toBe(1);
    filesystem.reap(connection.client);
    expect(Atomics.load(new Int32Array(connection.client.revocations[0]!), 0)).toBe(2);
    expect(sweeps).toBe(2);
  } finally { connection.client.port.close(); connection.server.port.close(); }
});
