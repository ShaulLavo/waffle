import { expect, test } from "bun:test";
import {
  FilesystemClient,
  FilesystemService,
  MemoryBackend,
  createFilesystemConnection,
} from "../fs";
import { ResidentAuthorityServer } from "../browser/publication-authority";
import { ResidentChannel, residentDescriptor, residentSession } from "../fs/publication-attachment";
import type { PublicationLimits } from "../fs/publication-internal";

const limits: PublicationLimits = {
  sessions: 16,
  operations: 16,
  inputBytes: 128,
  argumentBytes: 1024,
  effectBytes: 8192,
  effects: 32,
  resultBytes: 1024,
  logRecords: 16,
  logBytes: 131072,
  pins: 2,
  pinBytes: 256,
};

async function fixture() {
  const backend = new MemoryBackend();
  backend.fs.mkdirp("/dir");
  backend.fs.writeFile("/dir/a", new Uint8Array([1, 2, 3]));
  backend.fs.writeFile("/dir/b", new Uint8Array([4, 5]));
  const service = new FilesystemService(backend);
  const pair = createFilesystemConnection(undefined, { limits, observe: true });
  service.connect(pair.server);
  const root = new FilesystemClient(pair.client);
  const directory: number = await root.asyncCall("preopen", ["/"]);
  const file: { node: number } = await root.asyncCall("resolve", [directory, "dir/a"]);
  const workspace = `workspace-${crypto.randomUUID()}`;
  const descriptor = residentDescriptor(await root.asyncCall("publicationResident", [
    root.connection.publication!.observer, file.node, workspace,
  ]));
  const authority = service.residentPublication!;
  authority.activate();
  const guard = { release: () => Promise.resolve() };
  const server = new ResidentAuthorityServer(authority, guard, guard);
  const channel = new ResidentChannel(workspace);
  const session = residentSession(await channel.call("open", descriptor));
  return {
    channel, session, file: file.node,
    async stop() {
      await channel.call("close", { token: session.token });
      channel.close();
      await server.stop();
      root.dispose();
      service.dispose();
    },
  };
}

test("private connection queries the sole workspace namespace", async () => {
  const f = await fixture();
  try {
    const result = await f.channel.call("workspace", {
      token: f.session.token,
      request: { kind: "query", query: { kind: "stat", handle: f.file } },
    });
    expect(result).toMatchObject({ value: { kind: "file", size: 3 } });
  } finally {
    await f.stop();
  }
});
