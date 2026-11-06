import type { GraphicsConnection } from "./protocol.js";
import {
  atomicsLoad,
  DataViewConstructor,
  dataViewSetUint32,
  Int32ArrayConstructor,
  Uint8ArrayConstructor,
  wasmMemoryBuffer,
  wasmMemoryByteLength,
} from "../../proc/intrinsics.js";

const integer = Number.isInteger;
export function guestSpan(
  memory: () => WebAssembly.Memory,
  ptr: number,
  length: number,
): Uint8Array {
  const target = memory();
  if (!integer(ptr) || !integer(length)) throw new RangeError("Invalid guest span");
  ptr >>>= 0;
  length >>>= 0;
  const size = wasmMemoryByteLength(target);
  if (ptr > size || length > size - ptr) throw new RangeError("Guest span outside memory");
  return new Uint8ArrayConstructor(wasmMemoryBuffer(target), ptr, length);
}
export function guestOutput(
  memory: () => WebAssembly.Memory,
  ptr: number,
  length: number,
): DataView {
  guestSpan(memory, ptr, length);
  return new DataViewConstructor(wasmMemoryBuffer(memory()), ptr >>> 0, length >>> 0);
}
export function createDisplayImports(
  connection: GraphicsConnection,
  memory: () => WebAssembly.Memory,
  live: () => void,
) {
  const surfaces = connection.surfaces;
  return {
    surfaces(ptr: number, capacity: number): number {
      live();
      try {
        const output = guestOutput(memory, ptr, capacity >>> 0);
        if (capacity >>> 0 >= surfaces.length * 4)
          for (let index = 0; index < surfaces.length; index++)
            dataViewSetUint32(output, index * 4, surfaces[index]!.id, true);
        return surfaces.length;
      } catch {
        return -28;
      }
    },
    surface_info(id: number, ptr: number): number {
      live();
      try {
        const output = guestOutput(memory, ptr, 16);
        for (let index = 0; index < surfaces.length; index++) {
          if (surfaces[index]!.id !== id) continue;
          return readInfo(new Int32ArrayConstructor(surfaces[index]!.info), output);
        }
        return -8;
      } catch {
        return -28;
      }
    },
  };
}
function readInfo(info: Int32Array, output: DataView): number {
  for (let attempt = 0; attempt < 16; attempt++) {
    const version = atomicsLoad(info, 0);
    if (version & 1) continue;
    const width = atomicsLoad(info, 1),
      height = atomicsLoad(info, 2);
    const scale = atomicsLoad(info, 3),
      flags = atomicsLoad(info, 4);
    if (version !== atomicsLoad(info, 0)) continue;
    dataViewSetUint32(output, 0, width, true);
    dataViewSetUint32(output, 4, height, true);
    dataViewSetUint32(output, 8, scale, true);
    dataViewSetUint32(output, 12, flags, true);
    return 0;
  }
  return -6;
}
