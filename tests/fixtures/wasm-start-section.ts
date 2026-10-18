// Original fixture utility: chain libc discovery after LLD's memory initializer,
// inside a real Wasm start section (before WebAssembly.Instance returns).
function uleb(value: number): number[] {
  const bytes: number[] = [];
  do { const byte = value & 127; value >>>= 7; bytes.push(byte | (value ? 128 : 0)); } while (value);
  return bytes;
}
export function addStartSection(bytes: Uint8Array, name: string): Uint8Array {
  let offset = 8;
  const read = () => {
    let value = 0, shift = 0, byte: number;
    do { byte = bytes[offset++]!; value |= (byte & 127) << shift; shift += 7; } while (byte & 128);
    return value;
  };
  const sections: { id: number; data: number[] }[] = [];
  let index: number | undefined, original: number | undefined;
  const types: number[] = [];
  for (; offset < bytes.length;) {
    const id = bytes[offset++]!, size = read(), begin = offset, end = offset + size;
    if (id === 3) { const count = read(); for (let i = 0; i < count; i++) types.push(read()); }
    if (id === 8) original = read();
    if (id === 7) {
      const count = read();
      for (let i = 0; i < count; i++) {
        const length = read(), exportName = new TextDecoder().decode(bytes.subarray(offset, offset + length));
        offset += length;
        const kind = bytes[offset++]!, target = read();
        if (exportName === name && kind === 0) index = target;
      }
    }
    sections.push({ id, data: Array.from(bytes.subarray(begin, end)) });
    offset = end;
  }
  if (index === undefined) throw new Error(`missing start export ${name}`);
  const imports = WebAssembly.Module.imports(new WebAssembly.Module(bytes)).filter(item => item.kind === "function").length;
  const type = types[index - imports];
  if (type === undefined) throw new Error("start export must be a local function");
  const wrapper = imports + types.length;
  const body = [0].concat(original === undefined ? [] : [16].concat(uleb(original)), [16], uleb(index), [11]);
  for (const section of sections) {
    if (section.id === 3 || section.id === 10) {
      // Both sections begin with their function count, already known from section 3.
      const prefix = uleb(types.length).length;
      section.data = uleb(types.length + 1).concat(section.data.slice(prefix), section.id === 3 ? uleb(type) : uleb(body.length).concat(body));
    }
    if (section.id === 8) section.data = uleb(wrapper);
  }
  if (original === undefined) {
    const insert = sections.findIndex(section => section.id !== 0 && section.id > 8);
    sections.splice(insert < 0 ? sections.length : insert, 0, { id: 8, data: uleb(wrapper) });
  }
  return Uint8Array.from(Array.from(bytes.subarray(0, 8)).concat(sections.flatMap(section => [section.id].concat(uleb(section.data.length), section.data))));
}
