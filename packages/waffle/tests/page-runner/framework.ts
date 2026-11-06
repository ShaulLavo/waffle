import { PageFrameworkHost } from "./framework-host.js";
import type { FrameworkHost, FrameworkOptions } from "./framework-types.js";
export type {
  Json,
  ExpectedCase,
  SafariRequested,
  SafariReturned,
  AttachedConnection,
  FrameworkOptions,
  FrameworkHost,
  FrameworkResult,
  ProviderOperation,
  VitestEnd,
  FrameAdapter,
  TransportEvents,
  FrameworkTask,
  FrameworkUpdate,
  FrameworkGeometry,
} from "./framework-types.js";
export function createFrameworkHost(options: FrameworkOptions): FrameworkHost {
  return new PageFrameworkHost(options);
}
/** Loopback HTTP control only. Never qualifies a native browser or an executed file. */
export function createFrameworkControl(options: FrameworkOptions, endpoint: string): FrameworkHost {
  return new PageFrameworkHost(options, endpoint);
}
