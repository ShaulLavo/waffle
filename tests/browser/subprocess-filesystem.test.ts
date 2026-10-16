import { expect, test } from "bun:test";
import { FilesystemClient, FilesystemService, MemoryBackend, createFilesystemConnection } from "../../runtime/fs";
import { SharedPipe, SubprocessHost, childTransport, wasiPipe, type ChildTransport } from "../src/subprocess.js";

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
function fixture() {
  const root = createFilesystemConnection();
  const child = createFilesystemConnection(root.client);
  const backend = new MemoryBackend();
  const service = new FilesystemService(backend);
  service.connect(root.server); service.connect(child.server);
  const parentFS = new FilesystemClient(root.client);
  const childFS = new FilesystemClient(child.client);
  let transport: ChildTransport | undefined;
  const host = new SubprocessHost({ output() {}, launch(_meta, value) { transport = value; return { terminate() {} }; } });
  const id = host.spawn(JSON.stringify({ argv: ["bun", "-e", "0"] }));
  if (!transport) throw new Error("child was not launched");
  return { parentFS, childFS, host, id, transport,
    cleanup() { host.dispose(); childFS.dispose(); parentFS.dispose(); service.dispose(); } };
}

test("live filesystem edits precede child stdin and parent stdout without snapshots or child exit", async () => {
  const { parentFS, childFS, host, id, transport, cleanup } = fixture();
  try {
    const child = childTransport(transport);
    expect(transport.control.byteLength).toBe(16);
    expect("filesystem" in transport).toBe(false);
    await parentFS.asyncCall("writeFile", ["/entry.ts"], encode("export default 42"));
    expect(host.write(host.pipe(id, 0), encode("build"))).toBe(5);
    expect(child.stdin.read()).toEqual(encode("build"));
    expect(decode(await childFS.asyncCall("readFile", ["/entry.ts"]))).toBe("export default 42");
    await childFS.asyncCall("writeFile", ["/out.js"], encode("answer=42"));
    const stdout = wasiPipe(child.stdout, "write");
    expect(stdout.write([encode("built")])).toBe(5);
    expect(host.read(host.pipe(id, 1))).toEqual(encode("built"));
    expect(decode(await parentFS.asyncCall("readFile", ["/out.js"]))).toBe("answer=42");
    expect(host.wait(id)).toBe(-2);
  } finally { cleanup(); }
});

test("idle persistent children observe parent edits without stdin, stdout, or exit synchronization", async () => {
  const { parentFS, childFS, host, id, transport, cleanup } = fixture();
  try {
    await parentFS.asyncCall("writeFile", ["/entry.ts"], encode("before"));
    const root = await childFS.asyncCall("preopen", ["/"]);
    const path = await childFS.asyncCall("resolve", [root, "entry.ts"]);
    childFS.retain(path.node);
    const bytes = new Uint8Array(6);
    expect(childFS.read(path.node, [bytes], 0)).toBe(6);
    expect(decode(bytes)).toBe("before");
    await parentFS.asyncCall("writeFile", ["/entry.ts"], encode("newest"));
    host.poll();
    expect(childFS.read(path.node, [bytes], 0)).toBe(6);
    expect(decode(bytes)).toBe("newest");
    expect(new SharedPipe(transport.pipes[0], transport.budget).read()).toBe(-2);
    expect(host.wait(id)).toBe(-2);
    childFS.release(path.node);
  } finally { cleanup(); }
});

for (const replacement of [false, true]) test(`live child ${replacement ? "replacement" : "removal"} preserves open identities and unrelated parent writes`, async () => {
  const { parentFS, childFS, cleanup } = fixture();
  try {
    await parentFS.asyncCall("writeFile", ["/opened"], encode("original"));
    const root = await parentFS.asyncCall("preopen", ["/"]);
    const path = await parentFS.asyncCall("resolve", [root, "opened"]);
    parentFS.retain(path.node);
    await parentFS.asyncCall("writeFile", ["/unrelated"], encode("parent"));
    await childFS.asyncCall("remove", ["/opened"]);
    if (replacement) await childFS.asyncCall("writeFile", ["/opened"], encode("replacement"));
    const bytes = new Uint8Array(8);
    expect(parentFS.read(path.node, [bytes], 0)).toBe(8);
    expect(decode(bytes)).toBe("original");
    expect(decode(await parentFS.asyncCall("readFile", ["/unrelated"]))).toBe("parent");
    expect(await parentFS.asyncCall("readFile", ["/opened"])).toEqual(replacement ? encode("replacement") : undefined);
    parentFS.release(path.node);
    await parentFS.asyncCall("listFiles");
    expect(await parentFS.asyncCall("stat", [path.node]).catch(error => error)).toMatchObject({ errno: 8 });
  } finally { cleanup(); }
});
