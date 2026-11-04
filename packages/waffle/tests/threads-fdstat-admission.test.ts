import { expect, test } from "bun:test";
import { pages } from "../memory/reservations.ts";
import { inspectThreadSource } from "../memory/declarations.ts";
import { compileThreadGuest } from "../thread/guest-module.ts";
import { guestModule } from "./threads-guest-module.ts";

const spawn = { module: "wasi", name: "thread-spawn", params: [0x7f] };

test("thread source admits exactly Preview1 fd_fdstat_get(i32, i32) -> i32", async () => {
  const source = guestModule({
    imports: [spawn, { name: "fd_fdstat_get", params: [0x7f, 0x7f] }],
  });
  expect(inspectThreadSource(source)).toEqual({
    initialPages: pages(2),
    actualMaximumPages: pages(512),
    sourceMaximumPages: pages(512),
  });
  const module = await compileThreadGuest(source);
  expect(WebAssembly.Module.imports(module)).toContainEqual({
    module: "wasi_snapshot_preview1",
    name: "fd_fdstat_get",
    kind: "function",
  });
});

for (const params of [[], [0x7f], [0x7e, 0x7f], [0x7f, 0x7e], [0x7f, 0x7f, 0x7f]]) {
  test(`thread source rejects fd_fdstat_get parameters ${params.join(",")}`, () => {
    const source = guestModule({ imports: [spawn, { name: "fd_fdstat_get", params }] });
    expect(() => inspectThreadSource(source)).toThrow(WebAssembly.CompileError);
  });
}

test("thread source rejects a void fd_fdstat_get and other unsupported imports", () => {
  const wrongResult = guestModule({
    imports: [spawn, { name: "fd_fdstat_get", params: [0x7f, 0x7f], result: false }],
  });
  const unsupported = guestModule({
    imports: [spawn, { name: "fd_fdstat_set_flags", params: [0x7f, 0x7f] }],
  });
  expect(() => inspectThreadSource(wrongResult)).toThrow(WebAssembly.CompileError);
  expect(() => inspectThreadSource(unsupported)).toThrow(WebAssembly.CompileError);
});

const artifact = process.env.THREADS_FDSTAT_C_ARTIFACT;
test.skipIf(!artifact)("unchanged stock C source passes thread admission", async () => {
  const source = new Uint8Array(await Bun.file(artifact!).arrayBuffer());
  const digest = new Bun.CryptoHasher("sha256").update(source).digest("hex");
  expect(digest).toBe("72672a11a126d643db51ec568718c31cb3bde92070c74309a3f799b7be20e81d");
  expect(inspectThreadSource(source)?.initialPages).toBe(pages(17));
  const module = await compileThreadGuest(source);
  expect(WebAssembly.Module.imports(module)).toContainEqual({
    module: "wasi_snapshot_preview1",
    name: "fd_fdstat_get",
    kind: "function",
  });
});

for (const name of ["toString", "toLocaleString", "valueOf"]) {
  test(`thread source refuses inherited Object method ${name}`, () => {
    const source = guestModule({ imports: [spawn, { name, params: [] }] });
    expect(WebAssembly.validate(source)).toBe(true);
    expect(() => inspectThreadSource(source)).toThrow(WebAssembly.CompileError);
  });
}
