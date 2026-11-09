import { PageFrameworkHost } from "./framework-host.js";
import type { FrameworkHost, FrameworkOptions } from "./framework-types.js";
export type {
  CollectorObservation,
  CollectorDelivery,
  TesterTraceOptions,
  TesterTraceCapture,
  TraceCheckpoint,
  TraceFailure,
  TraceSettlement,
  Json,
  ExpectedCase,
  SafariRequested,
  SafariReturned,
  AttachedConnection,
  FrameworkOptions,
  FrameworkMiddlewareStack,
  FrameworkHost,
  FrameworkResult,
  ProviderOperation,
  ViewportOperation,
  ScreenshotOperation,
  VitestEnd,
  FrameAdapter,
  TransportEvents,
  FrameworkEvent,
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
