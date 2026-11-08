import type { IncomingMessage, ServerResponse } from "node:http";
import type { CleanupStep, DriverCleanup } from "./driver.js";

export type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json };
export type ExpectedCase = {
  readonly file: string;
  readonly fullName: string;
  readonly sourceKey: string;
  readonly timeoutMs: number;
  readonly retries: 0;
};
/** @public */
export type SafariRequested = Readonly<Record<string, Json>> & {
  readonly browserName: "Safari";
  readonly platformName: "iOS";
  readonly "safari:useSimulator": true;
  readonly "safari:deviceUDID": string;
};
export type SafariReturned = SafariRequested & { readonly browserVersion: string };
export type AttachedConnection = {
  readonly sessionId: string;
  readonly capabilities: SafariReturned;
  readonly requestedCapabilities: SafariRequested;
  readonly options: {
    readonly hostname: "127.0.0.1";
    readonly port: number;
    readonly protocol: "http";
    readonly path: "/";
    readonly logLevel: "silent";
    readonly connectionRetryCount: 0;
    readonly connectionRetryTimeout: 5000;
    readonly waitforTimeout: 60000;
    readonly waitforInterval: 100;
  };
};
export type FrameworkOptions = {
  readonly suite: string;
  readonly native: { readonly udid: string };
  readonly expected: readonly ExpectedCase[];
  readonly scope: {
    readonly kind: "root-selection";
    readonly command: "test:browser";
    readonly files: readonly [string];
  };
  readonly resultPath: string;
};
export type ProviderOperation = "open" | "test-frame" | "main-frame" | "framework-cleanup";
export type ViewportOperation = {
  readonly kind: "viewport";
  readonly width: number;
  readonly height: number;
};
export type ScreenshotOperation = { readonly kind: "screenshot"; readonly file: string };
export type VitestEnd =
  | { readonly status: "passed" }
  | {
      readonly status: "failed" | "interrupted";
      readonly errors: readonly Json[];
    };
export type FrameAdapter = {
  isTestFrame(): boolean;
  main(): Promise<void>;
  tester(): Promise<void>;
};
export type TransportEvents = {
  on(event: "request.performance", listener: (event: unknown) => void): unknown;
  off(event: "request.performance", listener: (event: unknown) => void): unknown;
};
export type FrameworkTask = {
  readonly id: string;
  readonly parentId: string | null;
  readonly type: "test" | "suite" | "file";
  readonly file: string;
  readonly fullName: string;
  readonly mode: string;
  readonly timeoutMs: number;
  readonly retries: number;
};
export type FrameworkUpdate = {
  readonly id: string;
  readonly state: "run" | "pass" | "fail" | "skip" | "todo";
  readonly errors: readonly Json[];
  readonly hooks: Json;
  readonly retryCount: number;
};
export type FrameworkEvent =
  | { readonly kind: "collected"; readonly tasks: readonly FrameworkTask[] }
  | { readonly kind: "task-started"; readonly id: string }
  | { readonly kind: "task-update" | "case-settled"; readonly updates: readonly FrameworkUpdate[] }
  | { readonly kind: "error"; readonly error: Json; readonly source: string }
  | { readonly kind: "execution-flushed" | "tester-cleanup-settled" | "cleanup-response-received" };
export type FrameworkGeometry = {
  readonly tester: { readonly width: number; readonly height: number; readonly dpr: number };
  readonly top: {
    readonly width: number;
    readonly height: number;
    readonly visualWidth: number;
    readonly visualHeight: number;
    readonly scale: number;
  };
  readonly iframe: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
};
export type CommandFailure = {
  readonly client: "direct" | "attached";
  readonly operation: string | null;
  readonly phase: string | null;
  readonly method: string | null;
  readonly path: string | null;
  readonly dispatchedAt: number;
  readonly settledAt: number;
  readonly stage: "headers" | "body" | "envelope" | "unknown";
  readonly status: number | null;
  readonly abort: "caller" | "deadline" | "revoked" | "unknown" | null;
};
export type FrameworkResult = {
  suite: string;
  run: string;
  expected: readonly ExpectedCase[];
  cases: {
    expected: ExpectedCase;
    actualId: string | null;
    started: boolean;
    outcome: FrameworkUpdate | null;
  }[];
  collection: readonly FrameworkTask[];
  events: FrameworkEvent[];
  documents: {
    kind: "orchestrator" | "tester";
    doc: string | null;
    acceptedThrough: number;
    ackedThrough: number | null;
    pending: number | null;
    cutoff: number | null;
  }[];
  binding: {
    windowHandle: string;
    iframeElementId: string;
    topUrl: string;
    testerUrl: string;
  } | null;
  commandFailures: readonly CommandFailure[];
  commandHooks: { operation: string | null; phase: "started" | "settled"; revoked: boolean }[];
  geometry: FrameworkGeometry | null;
  framework: VitestEnd | null;
  failures: { category: string; detail: string }[];
  fileComplete: boolean;
  rootBrowserSuiteComplete: false;
  omittedRootFiles: "not enumerated";
  cleanup: DriverCleanup & {
    callbacks: CleanupStep;
    provider: CleanupStep;
    context: CleanupStep;
    scratch: CleanupStep;
  };
  exit: number;
};
export type FrameworkMiddlewareStack = {
  readonly stack: readonly { readonly route: string; readonly handle: unknown }[];
  use(
    handler: (request: IncomingMessage, response: ServerResponse, next: () => void) => void,
  ): unknown;
};
export interface FrameworkHost {
  mount(server: FrameworkMiddlewareStack): void;
  readonly middleware: (
    request: IncomingMessage,
    response: ServerResponse,
    next: () => void,
  ) => void;
  instrumentDocument(input: { kind: "orchestrator" | "tester"; url: string; html: string }): string;
  attach<T>(input: {
    connect: (connection: AttachedConnection) => Promise<T>;
    detach: () => Promise<void>;
    frames: FrameAdapter;
  }): Promise<T>;
  openPage(actualUrl: string, open: () => Promise<void>): Promise<void>;
  provider(operation: ViewportOperation): Promise<void>;
  provider<T>(
    kind: ProviderOperation | ScreenshotOperation,
    operation: () => Promise<T>,
  ): Promise<T>;
  guardRequest<T extends RequestInit>(request: T): T;
  observeResponse<T extends { statusCode: number; body?: unknown }>(
    response: T,
    request: RequestInit,
  ): T;
  requestStarted(client: unknown): void;
  requestSettled(
    outcome: { kind: "completed" } | { kind: "transport-fault"; detail: string },
  ): void;
  detach(): Promise<void>;
  initialViewport(request: unknown): Promise<void>;
  run(
    execute: (registerClose: (close: () => Promise<void>) => void) => Promise<VitestEnd>,
  ): Promise<FrameworkResult>;
  abort(reason: string): Promise<FrameworkResult>;
}
