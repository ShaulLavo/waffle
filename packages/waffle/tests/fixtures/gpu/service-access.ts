import { createServiceReaders, attachServiceAccess } from "../../../browser/display/service-readers.js";
import { installSharedControlAllocator } from "../../../memory/control.js";
import { SharedMemoryLedger, bytes } from "../../../memory/reservations.js";
import { defaultSharedMemoryPlatform } from "../../../memory/platform.js";
const page = new SharedMemoryLedger(defaultSharedMemoryPlatform).openRuntime(defaultSharedMemoryPlatform);
export function serviceAccess() {
  const restore = installSharedControlAllocator((length) => page.buffer("control", { kind: "fixed-buffer", length: bytes(length) }));
  try { return attachServiceAccess(createServiceReaders().bootstrap); }
  finally { restore(); }
}
