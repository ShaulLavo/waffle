import { createRuntime, type Runtime } from "../index.js";
import { createPreview1Network } from "../browser/preview1-network.js";
import { createRing } from "../browser/net/ring.js";
import type { NetConnect } from "../browser/net/outbound.js";
import type { RuntimeWorkerMessage, RuntimeWorkerRequest } from "../browser/worker.js";
import { createRelayConnect } from "../../waffle-relay/src/tcp-client.js";
import type {
  WebTransportFactory,
  WebTransportLike,
} from "../../waffle-relay/src/tcp-webtransport.js";
import {
  requireCertificateRejection,
  type RelayBrowserConfig,
  type RelayMode,
  type RelayModeResult,
  type RelayProbe,
} from "./network-relay-contract.js";
import type { RelayGuestMessage, RelayGuestRequest } from "./network-relay-worker.js";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function bounded<T>(promise: Promise<T>, label: string, ms = 20000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
function probeFactory(probe: RelayProbe, badCertificate: boolean): WebTransportFactory | undefined {
  if (typeof WebTransport !== "function") return;
  return (url, options) => {
    const transport = new WebTransport(url, {
      serverCertificateHashes: badCertificate
        ? [{ algorithm: "sha-256", value: new Uint8Array(32).buffer }]
        : options.serverCertificateHashes?.slice(),
    });
    probe.constructed++;
    const ready = transport.ready.then(
      () => {
        probe.ready++;
      },
      (error: unknown) => {
        probe.failures.push(String(error));
        throw error;
      },
    );
    void ready.catch(() => {});
    void transport.closed.then(
      () => {
        probe.closed++;
      },
      () => {
        probe.closed++;
      },
    );
    return {
      ready,
      closed: transport.closed,
      close: (info) => transport.close(info),
      async createBidirectionalStream() {
        const stream = await transport.createBidirectionalStream();
        probe.streams++;
        return fragmentOpening(stream, probe);
      },
    } satisfies WebTransportLike;
  };
}
function fragmentOpening(
  stream: Awaited<ReturnType<WebTransportLike["createBidirectionalStream"]>>,
  probe: RelayProbe,
) {
  const writer = stream.writable.getWriter();
  let opening = true;
  return {
    readable: stream.readable,
    writable: new WritableStream<Uint8Array>({
      async write(bytes) {
        if (!opening) return writer.write(bytes);
        opening = false;
        for (const part of [bytes.subarray(0, 1), bytes.subarray(1, 7), bytes.subarray(7)]) {
          await writer.write(part);
          probe.fragments++;
        }
      },
      close: () => writer.close(),
      abort: (reason) => writer.abort(reason),
    }),
  };
}
async function helperTraffic(
  runtime: Runtime,
  connect: NetConnect,
  config: RelayBrowserConfig,
  dispose: "helper" | "runtime" = "helper",
): Promise<number> {
  const ring = createRing();
  const network = await runtime.network();
  const admitted = Promise.withResolvers<void>();
  let liveSignal: AbortSignal | undefined;
  let first = true;
  const helper = network.createHelper({
    ring,
    fetch: async () => {
      throw new Error("External HTTP fetch forbidden");
    },
    async connect(target, signal) {
      liveSignal = signal;
      if (first) {
        first = false;
        await admitted.promise;
      }
      return connect(target, signal);
    },
  });
  const worker = new Worker("/relay-helper-worker.js", { type: "module" });
  const result = Promise.withResolvers<number>();
  worker.onerror = (event) => {
    event.preventDefault();
    result.reject(new Error(event.message));
  };
  worker.onmessage = ({ data }: MessageEvent<RelayGuestMessage>) => {
    if (data.kind === "pending") return admitted.resolve();
    if (data.kind === "net") {
      helper.handle(data.request);
      return;
    }
    if (data.kind === "failure") result.reject(new Error(data.message));
    else result.resolve(data.bytes);
  };
  try {
    worker.postMessage({
      kind: dispose === "helper" ? "traffic" : "hold",
      ring,
      targets: config.targets,
    } satisfies RelayGuestRequest);
    const bytes = await bounded(result.promise, "Bun-shaped NetHost worker");
    check(liveSignal && !liveSignal.aborted, "Last helper socket was not live before disposal");
    return bytes;
  } finally {
    admitted.resolve();
    if (dispose === "runtime") await runtime.dispose();
    else helper.dispose();
    worker.terminate();
    check(!liveSignal || liveSignal.aborted, "Helper disposal did not cancel its live connector");
  }
}
async function preview1(
  runtime: Runtime,
  connect: NetConnect,
  target: { host: string; port: number },
  reset: boolean,
  expected: number,
): Promise<number> {
  const owner = await createPreview1Network(runtime, {
    sockets: [{ fd: 3, socket: { connect: target } }],
    connect,
  });
  check(owner, "Preview 1 launcher did not allocate its helper");
  check(
    Object.keys(owner.connection).sort().join(",") === "port,ring,sockets",
    "Connector authority crossed the worker boundary",
  );
  const filesystem = runtime.filesystem.fork();
  const worker = new Worker("/relay-preview1-worker.js", { type: "module" });
  const output: Uint8Array[] = [];
  const result = Promise.withResolvers<number>();
  worker.onerror = (event) => {
    event.preventDefault();
    result.reject(new Error(event.message));
  };
  worker.onmessage = ({ data }: MessageEvent<RuntimeWorkerMessage>) => {
    if (data.type === "stdout") {
      output.push(data.data);
      return;
    }
    if (data.type === "exit" && !data.cleanupErrors?.length) result.resolve(data.code);
    if (data.type === "error" || data.type === "cleanup-error")
      result.reject(new Error(JSON.stringify(data)));
  };
  try {
    const response = await fetch(reset ? "/relay-reset.wasm" : "/relay-echo.wasm");
    check(response.ok, "Preview 1 fixture module is missing");
    const module = await WebAssembly.compile(await response.arrayBuffer());
    worker.postMessage(
      {
        controlGrant: { kind: "unbounded" },
        module,
        args: [],
        env: {},
        filesystem,
        network: owner.connection,
      } satisfies RuntimeWorkerRequest,
      [filesystem.port, owner.connection.port],
    );
    const code = await bounded(result.promise, "Real Preview 1 worker");
    check(code === expected, `Preview 1 expected ${expected}, got ${code}`);
    const text = output.map((chunk) => new TextDecoder().decode(chunk)).join("");
    check(
      text === (expected === 0 ? "waffle echo\n" : ""),
      `Preview 1 bytes differ: ${JSON.stringify(text)}`,
    );
    return code;
  } finally {
    owner.dispose();
    worker.terminate();
    filesystem.port.close();
  }
}
async function idle(): Promise<void> {
  const response = await fetch("/relay-idle");
  check(response.ok, "Fixture cleanup acknowledgement failed");
  const report: unknown = await response.json();
  check(
    report &&
      typeof report === "object" &&
      "sockets" in report &&
      report.sockets === 0 &&
      "active" in report &&
      report.active === 0,
    "Fixture retained target sockets or admissions",
  );
}
async function mode(config: RelayBrowserConfig, selected: RelayMode): Promise<RelayModeResult> {
  const probe: RelayProbe = {
    constructed: 0,
    ready: 0,
    streams: 0,
    fragments: 0,
    closed: 0,
    failures: [],
  };
  const relay = createRelayConnect({
    endpoint: config.endpoint,
    getToken: () => config.token,
    carriers: selected === "websocket" ? ["websocket"] : undefined,
    webTransport: probeFactory(probe, selected === "bad-certificate"),
    connectTimeoutMs: 8000,
  });
  const runtime = createRuntime({ filesystem: { mode: "memory", workerURL: "/relay-fs.js" } });
  let result: RelayModeResult | undefined;
  const failures: unknown[] = [];
  try {
    check(relay.carrier === null, "Carrier reported success before its open reply");
    const started = performance.now();
    const echo = await preview1(runtime, relay.connect, config.targets.echo, false, 0);
    const reset = await preview1(runtime, relay.connect, config.targets.echo, true, 15);
    const helperBytes = await helperTraffic(runtime, relay.connect, config);
    const fallbackMs = performance.now() - started;
    const carrier = relay.carrier;
    check(carrier === "webtransport" || carrier === "websocket", "Actual carrier was not reported");
    if (selected !== "selected")
      check(carrier === "websocket", `${selected} did not use WebSocket`);
    if (carrier === "webtransport")
      check(
        probe.ready > 0 && probe.streams > 0 && probe.fragments >= 3,
        "WebTransport selected before the complete fragmented open exchange",
      );
    if (selected === "websocket")
      check(probe.constructed === 0, "Forced WebSocket touched WebTransport");
    if (selected === "bad-certificate" && typeof WebTransport === "function")
      requireCertificateRejection(probe);
    check(fallbackMs < 15000, "Carrier fallback exceeded its bounded deadline");
    await idle();
    const denied = await preview1(runtime, relay.connect, config.targets.denied, false, 2);
    check(
      (await helperTraffic(runtime, relay.connect, config, "runtime")) === 0,
      "Runtime disposal fixture did not keep its live socket",
    );
    await idle();
    result = {
      mode: selected,
      carrier,
      probe,
      helperBytes,
      preview1: { echo, denied, reset },
      fallbackMs,
    };
  } catch (error) {
    console.log(
      JSON.stringify({ mode: selected, carrier: relay.carrier, probe, failure: String(error) }),
    );
    failures.push(error);
  } finally {
    const receipts = await Promise.allSettled([
      runtime.dispose(),
      bounded(relay.close(), "Relay client disposal"),
    ]);
    failures.push(
      ...receipts.flatMap((receipt) => (receipt.status === "rejected" ? [receipt.reason] : [])),
    );
    await idle();
    if (probe.closed !== probe.constructed)
      failures.push(new Error("WebTransport session survived client disposal"));
    console.log(
      JSON.stringify({
        modeCleanup: selected,
        carrier: relay.carrier,
        probe,
        failures: failures.map(String),
      }),
    );
  }
  if (failures.length) throw new AggregateError(failures, failures.map(String).join("; "));
  check(result, "Relay mode did not produce a result");
  return result;
}

function configuration(value: unknown): RelayBrowserConfig {
  check(value && typeof value === "object", "Invalid relay fixture config");
  check("endpoint" in value && typeof value.endpoint === "string", "Invalid relay endpoint");
  check("token" in value && typeof value.token === "string", "Invalid relay fixture token");
  check("native" in value && typeof value.native === "boolean", "Invalid relay native mode");
  check(
    "targets" in value && value.targets && typeof value.targets === "object",
    "Invalid relay targets",
  );
  const targets = value.targets;
  check(
    "echo" in targets && "ssl" in targets && "refused" in targets && "denied" in targets,
    "Missing relay target",
  );
  return {
    endpoint: value.endpoint,
    token: value.token,
    native: value.native,
    targets: {
      echo: target(targets.echo),
      ssl: target(targets.ssl),
      refused: target(targets.refused),
      denied: target(targets.denied),
    },
  };
}
function target(value: unknown): { host: string; port: number } {
  check(value && typeof value === "object", "Invalid target");
  check("host" in value && typeof value.host === "string", "Invalid target host");
  check(
    "port" in value &&
      typeof value.port === "number" &&
      Number.isInteger(value.port) &&
      value.port > 0 &&
      value.port <= 65535,
    "Invalid target port",
  );
  return { host: value.host, port: value.port };
}
export async function networkRelayBrowserCases(): Promise<RelayModeResult[]> {
  check(
    crossOriginIsolated && typeof SharedArrayBuffer === "function",
    "Relay worker fixtures require COOP/COEP",
  );
  const response = await fetch("/relay-config");
  check(response.ok, "Relay fixture config is missing");
  const config = configuration(await response.json());
  const modes: RelayMode[] = config.native
    ? ["selected", "websocket", "bad-certificate"]
    : ["websocket"];
  const results: RelayModeResult[] = [];
  const failures: unknown[] = [];
  for (const selected of modes) {
    try {
      const result = await mode(config, selected);
      results.push(result);
      console.log(JSON.stringify({ relayMode: result }));
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, failures.map(String).join("; "));
  return results;
}
