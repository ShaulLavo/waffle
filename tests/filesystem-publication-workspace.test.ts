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
  const descriptor = residentDescriptor(await root.asyncCall("publicationWorkspace", [
    root.connection.publication!.observer, directory, workspace,
  ]));
  const authority = service.residentPublication!;
  authority.activate();
  const guard = { release: () => Promise.resolve() };
  const server = new ResidentAuthorityServer(authority, guard, guard);
  const channel = new ResidentChannel(workspace);
  const session = residentSession(await channel.call("open", descriptor));
  return {
    channel, session, root, backend, directory, file: file.node,
    async stop() {
      await channel.call("close", { token: session.token });
      channel.close();
      await server.stop();
      root.dispose();
      service.dispose();
    },
  };
}

async function call(f: Awaited<ReturnType<typeof fixture>>, operation: string, args: unknown[] = [], input = new Uint8Array(), id?: unknown): Promise<Record<string, unknown>> {
  const value = await f.channel.call("workspace", {
    token: f.session.token,
    request: { operation, args, input, id },
  });
  if (!value || typeof value !== "object") throw new Error("missing workspace result");
  return Object.fromEntries(Object.entries(value));
}
async function rejectsErrno(action: Promise<unknown>, errno: number): Promise<void> {
  await expect(action).rejects.toMatchObject({ errno });
}
test("private connection queries the sole workspace namespace", async () => {
  const f = await fixture();
  try {
    await call(f, "preopen", ["/"]);
    const resolved = await call(f, "resolve", [f.directory, "dir/a"]);
    expect(resolved.value).toMatchObject({ node: f.file });
    const result = await call(f, "stat", [f.file]);
    expect(result).toMatchObject({ value: { kind: "file", size: 3 } });
    expect(f.backend.shared.cells.buffer).toBe(f.root.connection.shared);
  } finally { await f.stop(); }
});
test("namespace mutations use exact session identities and preserve one complete receipt", async () => {
  const f = await fixture();
  try {
    await call(f, "preopen", ["/"]);
    const id = await f.channel.call("workspaceNext", { token: f.session.token });
    const before = f.backend.shared.publication!.cut();
    const first = await call(f, "writeFile", ["/dir/c"], new Uint8Array([7]), id);
    const repeat = await call(f, "writeFile", ["/dir/c"], new Uint8Array([7]), id);
    expect(repeat.receipt).toEqual(first.receipt);
    expect(f.backend.shared.publication!.cut().generation).toBe(before.generation + 1);
    await rejectsErrno(call(f, "writeFile", ["/dir/c"], new Uint8Array([8]), id), 28);
    expect(await f.channel.call("workspaceReceipt", { token: f.session.token, id })).toMatchObject({ kind: "committed", receipt: first.receipt });
    expect(await f.channel.call("workspaceReceipt", { token: f.session.token, id: { session: 1, sequence: 1 } })).toEqual({ kind: "unknown" });
    await rejectsErrno(call(f, "publicationChanges", [f.root.connection.publication!.observer, before, limits.logBytes]), 2);
    const changes = await f.root.asyncCall("publicationChanges", [f.root.connection.publication!.observer, before, limits.logBytes]);
    expect(changes).toMatchObject({ kind: "changes" });
    expect(changes.publications).toHaveLength(1);
  } finally { await f.stop(); }
});
test("retained files survive rename, replacement and unlink with current permissions", async () => {
  const f = await fixture();
  try {
    await call(f, "preopen", ["/"]);
    const old = await call(f, "resolve", [f.directory, "dir/a"]);
    const target = await call(f, "resolve", [f.directory, "dir/replaced"]);
    await call(f, "rename", [old.value, target.value]);
    await call(f, "writeFile", ["/dir/a"], new Uint8Array([9]));
    expect((await call(f, "read", [f.file, 3, 0])).value).toEqual(new Uint8Array([1, 2, 3]));
    const renamed = await call(f, "resolve", [f.directory, "dir/replaced"]);
    await call(f, "removePath", [renamed.value, false]);
    expect((await call(f, "stat", [f.file])).value).toMatchObject({ kind: "file", size: 3 });
    await call(f, "setMode", [f.file, 0]);
    await rejectsErrno(call(f, "read", [f.file, 3, 0]), 2);
  } finally { await f.stop(); }
});
