export async function preview1ListenerModule(): Promise<Uint8Array<ArrayBuffer>> {
  const { default: wabt } = await import("wabt");
  const compiler = await wabt();
  const name = "preview1-listener.wat";
  const source = await Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).text();
  const parsed = compiler.parseWat(name, source);
  try {
    return Uint8Array.from(parsed.toBinary({}).buffer);
  } finally {
    parsed.destroy();
  }
}
