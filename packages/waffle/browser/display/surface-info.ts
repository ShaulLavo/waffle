import { atomicsLoad, dataViewSetUint32 } from "../../proc/intrinsics.js";

export function readSurfaceInfo(info: Int32Array, output: DataView): number {
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
