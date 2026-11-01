import assert from "node:assert/strict";

export async function relaySocketModules(): Promise<Map<string, Uint8Array<ArrayBuffer>>> {
  const { default: wabt } = await import("wabt");
  const compiler = await wabt();
  const source = await Bun.file(new URL("./fixtures/preview1-relay.wat", import.meta.url)).text();
  const modules = new Map<string, Uint8Array<ArrayBuffer>>();
  for (const [path, text] of [
    ["/relay-echo.wasm", source],
    ["/relay-reset.wasm", source.replace("waffle echo\\0a", "RESET\\0aabcdef")],
  ]) {
    assert.ok(path && text);
    const parsed = compiler.parseWat(path, text);
    try {
      modules.set(path, Uint8Array.from(parsed.toBinary({}).buffer));
    } finally {
      parsed.destroy();
    }
  }
  return modules;
}
