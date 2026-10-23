import { expect, test } from "bun:test";
import { MemoryBackend } from "../fs/backend";
import { FilesystemClient } from "../fs/client";
import { FilesystemService } from "../fs/service";
import { createFilesystemConnection } from "../fs/protocol";
import { ResidentChannel, residentDescriptor, residentSession } from "../fs/publication-attachment";
import { ResidentAuthorityServer } from "../browser/publication-authority";
import { runStep } from "./persistent-lifecycle-r2-browser-runner";

async function fixture() {
  const backend = new MemoryBackend(), service = new FilesystemService(backend);
  const connection = createFilesystemConnection(undefined, { limits: { sessions: 8, operations: 16, inputBytes: 64, argumentBytes: 512, effects: 16, effectBytes: 4096, resultBytes: 256, logRecords: 8, logBytes: 32768, pins: 2, pinBytes: 256 }, observe: true });
  service.connect(connection.server);
  const root = new FilesystemClient(connection.client);
  const handle: number = await root.asyncCall("preopen", ["/"]);
  const workspace = `lifecycle-unit-${crypto.randomUUID()}`;
  const descriptor = residentDescriptor(await root.asyncCall("publicationWorkspace", [root.connection.publication!.observer, handle, workspace]));
  const authority = service.residentPublication!;
  authority.activate();
  const released: string[] = [];
  const server = new ResidentAuthorityServer(authority, { async release() { released.push("continuity"); } }, { async release() { released.push("bootstrap"); } });
  const channel = new ResidentChannel(workspace);
  return { backend, root, authority, descriptor, server, channel, released, async close() { channel.close(); await server.stop(); root.dispose(); service.dispose(); } };
}
test("final borrower close allows a fresh session without stopping the explicit authority", async () => {
  const owned = await fixture();
  try {
    const first = residentSession(await owned.channel.call("open", owned.descriptor));
    await owned.channel.finish("close", { token: first.token });
    expect(owned.released).toEqual([]);
    expect(owned.backend.shared.publication!.stopped).toBe(false);
    const next = residentSession(await owned.channel.call("open", owned.descriptor));
    expect(next.token).not.toBe(first.token);
    expect(next.descriptor).toEqual(first.descriptor);
    await expect(owned.channel.call("settle", { token: first.token, outcome: { kind: "cancelled", grant: "old-grant" } })).rejects.toMatchObject({ errno: 11 });
    await owned.channel.finish("close", { token: next.token });
    await owned.server.drainForOwner();
    expect(owned.released).toEqual([]);
    await owned.server.finishStop();
    expect(owned.released).toEqual(["continuity", "bootstrap"]);
  } finally { await owned.close(); }
});
test("a failed native schedule keeps completed failure and unrun cells", async () => {
  const steps: Parameters<typeof runStep>[0] = ["saved", "loss", "reopen"].map((name) => ({ name, kind: "unrun" }));
  await runStep(steps, 0, async () => "native-saved");
  await expect(runStep(steps, 1, async () => { throw new Error("causal failure"); })).rejects.toThrow("causal failure");
  expect(steps).toEqual([{ name: "saved", kind: "completed", value: "native-saved" }, { name: "loss", kind: "failed", failure: "Error: causal failure" }, { name: "reopen", kind: "unrun" }]);
});
