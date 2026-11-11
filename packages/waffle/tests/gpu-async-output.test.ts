import { serviceAccess } from "./fixtures/gpu/service-access.js";
import { expect, test } from "bun:test";
import { outputStruct, WireReader, wireObject } from "../browser/gpu/codec.js";
import { CompletionOwner } from "../browser/gpu/completions.js";
import { PayloadDirectory } from "../browser/gpu/payload.js";
import { RecordRing } from "../browser/gpu/ring.js";
import { gpuPayloadLayout } from "../browser/display/generated/graphics-layout.js";
import expected from "./fixtures/gpu/async-expected.json";

for (const vector of expected.structs) {
  test(`reused shared payload has canonical zero padding for ${vector.name}`, () => {
    const literal = Uint8Array.from(Buffer.from(vector.hex.replaceAll(/\s/g, ""), "hex"));
    const value = wireObject(new WireReader(literal).type(`struct.${vector.name}`));
    const commands = new RecordRing(new SharedArrayBuffer(4160), 8);
    const replies = new RecordRing(new SharedArrayBuffer(4160), 16);
    const arena = new SharedArrayBuffer(gpuPayloadLayout.byteLength);
    const owner = new CompletionOwner({
      access: serviceAccess(),
      commands,
      replies,
      arena: new Uint8Array(arena),
    });
    const directory = new PayloadDirectory(arena);
    const terminal = () => commands.terminal()?.reason;
    const terminate = (reason: number) => {
      owner.terminate(reason);
      return terminal() ?? 0;
    };
    try {
      const before = owner.allocatePayload(new Uint8Array(literal.length).fill(0xa5));
      if (!before) throw new Error("Missing initial payload");
      expect(directory.copyOnce(before, new Uint8Array(literal.length), terminal, terminate)).toBe(
        0,
      );
      const next = owner.fillPayload(outputStruct(vector.name, value), (span) =>
        outputStruct(vector.name, value, span),
      );
      if (!next) throw new Error("Missing reused payload");
      expect(next.id).toBe(before.id);
      expect(next.generation).toBe(before.generation + 1);
      const actual = new Uint8Array(literal.length);
      expect(directory.copyOnce(next, actual, terminal, terminate)).toBe(0);
      expect<Uint8Array>(actual).toEqual(literal);
      expect(new WireReader(actual).type(`struct.${vector.name}`)).toEqual(value);
    } finally {
      owner.terminate(1);
    }
  });
}
