import { inspectorEndpoint } from "./inspector-endpoint.js";
import { SafariObserver, observationIdentityExpression } from "./safari-observer.js";
import { spawn, type ChildProcess } from "node:child_process";
import { isNativeError } from "node:util/types";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import type { AttachedConnection, CommandFailure } from "./framework-types.js";
import { parseCapabilities } from "./framework-validation.js";
import { openSync, closeSync } from "node:fs";
import { join } from "node:path";
import {
  bounded,
  WebDriverError,
  parseSession,
  stringValue,
  type Driver,
  type DriverCleanup,
  type DriverPressControl,
  type DriverObservation,
  type DriverObservationBinding,
  type CleanupStep,
} from "./driver.js";
import { record, type HostKey } from "./protocol.js";
import { commandMethod, commandPath } from "./framework-queue.js";
function nativeKey(key: HostKey): string {
  switch (key) {
    case "Home":
      return "\uE011";
    case "ArrowUp":
      return "\uE013";
    case "ArrowRight":
      return "\uE014";
    case "Enter":
      return "\uE006";
    default: {
      const exhaustive: never = key;
      return exhaustive;
    }
  }
}
export type NativeCommandFailure = CommandFailure & {
  readonly errorName: string | null;
  readonly errorCode: string | null;
};
const errorNames = new Set([
  "Error",
  "TypeError",
  "SyntaxError",
  "RangeError",
  "ReferenceError",
  "URIError",
  "EvalError",
  "AggregateError",
  "AbortError",
  "TimeoutError",
  "WebDriverError",
]);
const errorPrototypes = new Map<object, string>([
  [Error.prototype, "Error"],
  [TypeError.prototype, "TypeError"],
  [SyntaxError.prototype, "SyntaxError"],
  [RangeError.prototype, "RangeError"],
  [ReferenceError.prototype, "ReferenceError"],
  [URIError.prototype, "URIError"],
  [EvalError.prototype, "EvalError"],
  [AggregateError.prototype, "AggregateError"],
]);
function failureName(error: unknown): string | null {
  // Caller abort reasons can carry accessors or proxy traps.
  if (!isNativeError(error)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(error, "name");
  const name: unknown = descriptor?.value;
  if (descriptor) return typeof name === "string" && errorNames.has(name) ? name : null;
  return errorPrototypes.get(Object.getPrototypeOf(error)) ?? null;
}
const w3cErrors = new Set([
  "element click intercepted",
  "element not interactable",
  "insecure certificate",
  "invalid argument",
  "invalid cookie domain",
  "invalid element state",
  "invalid selector",
  "invalid session id",
  "javascript error",
  "move target out of bounds",
  "no such alert",
  "no such cookie",
  "no such element",
  "no such frame",
  "no such shadow root",
  "no such window",
  "detached shadow root",
  "script timeout",
  "session not created",
  "stale element reference",
  "timeout",
  "unable to capture screen",
  "unable to set cookie",
  "unexpected alert open",
  "unknown command",
  "unknown error",
  "unknown method",
  "unsupported operation",
]);
const navigationTimeoutMs = 30_000;
export const driverResponseLimit = 4 * 1024 * 1024;
export async function readDriverResponse(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  if (!response.body) throw new Error("Missing WebDriver response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0,
    text = "";
  const abort = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > driverResponseLimit)
        throw new Error("WebDriver response exceeds 4 MiB UTF-8 limit");
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    signal.throwIfAborted();
    return JSON.parse(text);
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
    signal.removeEventListener("abort", abort);
  }
}
export function nativeCapabilities(value: unknown, udid: string) {
  if (!record(value) || !record(value.capabilities))
    throw new Error("Missing native session capabilities");
  const caps = value.capabilities;
  if (
    caps.browserName !== "Safari" ||
    caps.platformName !== "iOS" ||
    caps["safari:useSimulator"] !== true ||
    caps["safari:deviceUDID"] !== udid
  )
    throw new Error(
      "Returned WebDriver session is not Safari on the exact requested iOS Simulator",
    );
  if (typeof caps.browserVersion !== "string" || !caps.browserVersion)
    throw new Error("Missing installed Safari version");
  return {
    browserName: caps.browserName,
    browserVersion: caps.browserVersion,
    platformName: caps.platformName,
    simulator: true,
    deviceUDID: udid,
    platformVersion:
      typeof caps["safari:platformVersion"] === "string" ? caps["safari:platformVersion"] : null,
    deviceName: typeof caps["safari:deviceName"] === "string" ? caps["safari:deviceName"] : null,
  };
}
function returnedIdentity(value: unknown, sessionId: string): string {
  const caps = record(value) && record(value.capabilities) ? value.capabilities : {};
  return JSON.stringify({
    sessionId,
    browserName: caps.browserName,
    browserVersion: caps.browserVersion,
    platformName: caps.platformName,
    deviceUDID: caps["safari:deviceUDID"],
    simulator: caps["safari:useSimulator"],
    platformVersion: caps["safari:platformVersion"],
    deviceName: caps["safari:deviceName"],
  });
}
const serviceLabel = "com.apple.WebDriver.HTTPService";
const serviceExecutable =
  "/System/Library/PrivateFrameworks/WebDriver.framework/Versions/A/XPCServices/com.apple.WebDriver.HTTPService.xpc/Contents/MacOS/com.apple.WebDriver.HTTPService";
function joined(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
}
async function availablePort(): Promise<number> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No reserved driver port");
    return address.port;
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
async function tool(args: string[], allowMissing = false): Promise<string> {
  const executable = args[0];
  if (!executable) throw new Error("Missing executable");
  const child = spawn(executable, args.slice(1), { stdio: ["ignore", "pipe", "ignore"] });
  const exit = joined(child);
  let text = "";
  child.stdout?.on("data", (chunk) => {
    text += String(chunk);
  });
  try {
    const code = await bounded(exit, 2000, executable);
    if (code !== 0 && !allowMissing) throw new Error(`${executable} exited ${code}`);
    return code === 0 ? text : "";
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await bounded(exit, 1000, "observation tool exit");
  }
}
export type Association =
  | { kind: "launcher" }
  | { kind: "launchd-service"; pid: number; started: string };
/** Read-only association from the diagnostic's verified launcher-domain path. No service signals. */
export function associateListener(
  text: string,
  domain: string,
  identity: string,
  launcher: number,
  port: number,
  uid: number,
): Association | null {
  const lines = text.trim().split("\n");
  const pids = lines.filter((line) => line.startsWith("p"));
  const names = lines.filter((line) => line.startsWith("n"));
  if (
    pids.length !== 1 ||
    names.length === 0 ||
    !names.every((line) =>
      [`n127.0.0.1:${port}`, `n*:${port}`, `n[::1]:${port}`, `nlocalhost:${port}`].includes(line),
    )
  )
    return null;
  const pid = Number(pids[0]?.slice(1));
  if (pid === launcher) return { kind: "launcher" };
  if (domain.split("\n")[0]?.trim() !== `pid/${launcher}/${serviceLabel} = {`) return null;
  const domainPids = domain.split("\n").filter((line) => line.startsWith("\tpid = "));
  if (domainPids.length !== 1 || domainPids[0]?.trim() !== `pid = ${pid}`) return null;
  const match =
    /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+?)\s*$/.exec(
      identity,
    );
  if (
    !match ||
    Number(match[1]) !== pid ||
    Number(match[2]) !== 1 ||
    Number(match[3]) !== uid ||
    match[5] !== serviceExecutable
  )
    return null;
  return { kind: "launchd-service", pid, started: match[4] ?? "" };
}
export class SafariDriver implements Driver {
  private child: ChildProcess | undefined;
  private childExit: Promise<number | null> | undefined;
  private descriptor: AttachedConnection | undefined;
  private base = "";
  private port = 0;
  private session: string | undefined;
  private sessionIdentity = "No returned session";
  private association: Association | null = null;
  private stopping: Promise<DriverCleanup> | undefined;
  uncertain = false;
  constructor(
    private readonly udid: string,
    private readonly scratch: string,
    private readonly observeFailure?: (facts: NativeCommandFailure) => void,
    private readonly inspectorReceipt = process.env.WAFFLE_SAFARI_INSPECTOR_ENDPOINT,
  ) {}
  private observation: DriverObservation | undefined;
  async observe(binding: DriverObservationBinding): Promise<DriverObservation> {
    if (this.observation) throw new Error("Prior browser observer was not retired");
    if (!this.inspectorReceipt)
      throw new Error(
        "Safari observation requires an exact read-only endpoint helper receipt in WAFFLE_SAFARI_INSPECTOR_ENDPOINT",
      );
    if (!this.descriptor || this.descriptor.capabilities["safari:deviceUDID"] !== this.udid)
      throw new Error("No exact SafariDriver session owns observation");
    const actual = new AbortController().signal;
    if (
      (await this.handle(actual)) !== binding.window ||
      (await this.url(actual)) !== binding.bootstrapURL
    )
      throw new Error("SafariDriver bootstrap ownership changed");
    const identity = await this.script(`return ${observationIdentityExpression};`, actual);
    const wanted = JSON.stringify({
      url: binding.bootstrapURL,
      marker: new URL(binding.bootstrapURL).searchParams.get("token"),
    });
    if (identity !== wanted) throw new Error("SafariDriver bootstrap document changed");
    const path = await inspectorEndpoint(this.inspectorReceipt, this.udid);
    const observer = await SafariObserver.open(path, binding);
    this.observation = observer;
    const stop = observer.stop.bind(observer);
    let retirement: Promise<void> | undefined;
    const owned: DriverObservation = {
      failure: observer.failure,
      navigationComplete: () => observer.navigationComplete(),
      check: () => observer.check(),
      workers: () => observer.workers(),
      onRequest: (callback) => observer.onRequest(callback),
      revoke: () => observer.revoke(),
      stop: () =>
        (retirement ??= stop().then(() => {
          this.observation = undefined;
        })),
    };
    return owned;
  }
  async start(signal: AbortSignal): Promise<void> {
    this.port = await availablePort();
    this.base = `http://127.0.0.1:${this.port}`;
    const log = openSync(join(this.scratch, "safaridriver.log"), "w");
    try {
      this.child = spawn("/usr/bin/safaridriver", ["-p", String(this.port)], {
        stdio: ["ignore", log, log],
      });
      this.childExit = joined(this.child);
      void this.childExit.catch(() => {});
    } finally {
      closeSync(log);
    }
    await this.ready(signal);
    await this.createSession(signal);
  }
  async startControl(endpoint: string, signal: AbortSignal): Promise<void> {
    const url = new URL(endpoint);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      !url.port ||
      url.pathname !== "/" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Control endpoint must be an explicit loopback HTTP port");
    this.port = Number(url.port);
    this.base = url.origin;
    await this.createSession(signal);
  }
  connection(): AttachedConnection {
    if (!this.descriptor) throw new Error("No validated attached session");
    return this.descriptor;
  }
  private async createSession(signal: AbortSignal): Promise<void> {
    this.uncertain = true;
    const requested = {
      browserName: "Safari",
      platformName: "iOS",
      "safari:useSimulator": true,
      "safari:deviceUDID": this.udid,
    } as const;
    const value = await this.request(
      "POST",
      "/session",
      {
        capabilities: {
          alwaysMatch: requested,
        },
      },
      signal,
    );
    this.session = parseSession(value);
    this.uncertain = false;
    this.sessionIdentity = returnedIdentity(value, this.session);
    nativeCapabilities(value, this.udid);
    const capabilities = parseCapabilities(
      record(value) ? value.capabilities : undefined,
      this.udid,
    );
    this.descriptor = {
      sessionId: this.session,
      capabilities,
      requestedCapabilities: requested,
      options: {
        hostname: "127.0.0.1",
        port: this.port,
        protocol: "http",
        path: "/",
        logLevel: "silent",
        connectionRetryCount: 0,
        connectionRetryTimeout: 5000,
        waitforTimeout: 60000,
        waitforInterval: 100,
      },
    };
    await this.command(
      "POST",
      "/timeouts",
      { implicit: 0, pageLoad: navigationTimeoutMs, script: 3000 },
      signal,
    );
  }
  private async observeListener(): Promise<Association | null> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null)
      throw new Error("SafariDriver launcher exited");
    const listeners = await tool(
      ["/usr/sbin/lsof", "-nP", `-iTCP:${this.port}`, "-sTCP:LISTEN", "-Fpn"],
      true,
    );
    const pid = Number(
      listeners
        .split("\n")
        .find((line) => line.startsWith("p"))
        ?.slice(1),
    );
    const domain = await tool(
      ["/bin/launchctl", "print", `pid/${child.pid}/${serviceLabel}`],
      true,
    );
    const identity = pid
      ? await tool(["/bin/ps", "-p", String(pid), "-o", "pid=,ppid=,uid=,lstart=,comm="], true)
      : "";
    return associateListener(
      listeners,
      domain,
      identity,
      child.pid ?? -1,
      this.port,
      process.getuid?.() ?? -1,
    );
  }
  private async ready(signal: AbortSignal): Promise<void> {
    const until = performance.now() + 15_000;
    while (performance.now() < until) {
      signal.throwIfAborted();
      const first = await this.observeListener();
      if (first && (await this.confirm(first, signal))) return;
      await delay(100);
    }
    throw new Error("SafariDriver listener association/readiness unavailable");
  }
  private async confirm(first: Association, signal: AbortSignal): Promise<boolean> {
    try {
      await this.request("GET", "/status", undefined, signal, 1000, false);
      const again = await this.observeListener();
      if (JSON.stringify(first) !== JSON.stringify(again)) return false;
      this.association = again;
      return true;
    } catch {
      return false;
    }
  }
  private async request(
    method: string,
    path: string,
    body: unknown,
    signal: AbortSignal,
    ms = 5000,
    marksUncertain = true,
  ): Promise<unknown> {
    const dispatchedAt = this.observeFailure ? performance.now() : 0;
    const deadline = AbortSignal.timeout(ms);
    const requestSignal = AbortSignal.any([signal, deadline]);
    let stage: CommandFailure["stage"] = "headers";
    let status: number | null = null;
    let errorCode: string | null = null;
    try {
      const response = await fetch(this.base + path, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        signal: requestSignal,
      });
      stage = "body";
      if (this.observeFailure) status = response.status;
      const answer: unknown = await readDriverResponse(response, requestSignal);
      stage = "envelope";
      if (!record(answer) || !Object.hasOwn(answer, "value"))
        throw new Error(`WebDriver ${path}: ${JSON.stringify(answer)}`);
      const value = answer.value;
      const code = record(value) ? value.error : undefined;
      if (typeof code === "string") {
        errorCode = w3cErrors.has(code) ? code : null;
        throw new WebDriverError(
          code,
          record(value) && typeof value.message === "string"
            ? value.message
            : JSON.stringify(value),
        );
      }
      if (!response.ok) throw new Error(`WebDriver ${path}: ${JSON.stringify(answer)}`);
      return answer.value;
    } catch (error) {
      if (marksUncertain) this.uncertain = true;
      if (this.observeFailure) {
        this.reportFailure(
          {
            client: "direct",
            operation: null,
            phase: null,
            method: commandMethod(method),
            path: commandPath(path),
            dispatchedAt,
            settledAt: performance.now(),
            stage,
            status,
            abort:
              signal.aborted && requestSignal.reason === signal.reason
                ? "caller"
                : deadline.aborted && requestSignal.reason === deadline.reason
                  ? "deadline"
                  : requestSignal.aborted
                    ? "unknown"
                    : null,
          },
          error,
          errorCode,
        );
      }
      throw error;
    }
  }
  private reportFailure(facts: CommandFailure, error: unknown, errorCode: string | null): void {
    try {
      const errorName = facts.abort === "deadline" ? "TimeoutError" : failureName(error);
      this.observeFailure?.(Object.freeze({ ...facts, errorName, errorCode }));
    } catch {
      // Observation cannot replace the operation's rejection.
    }
  }
  private command(
    method: string,
    path: string,
    body: unknown,
    signal: AbortSignal,
    ms = 5000,
  ): Promise<unknown> {
    if (!this.session) throw new Error("No owned WebDriver session");
    if (this.uncertain) throw new Error("Uncertain WebDriver completion, dispatch stopped");
    return this.request(
      method,
      `/session/${encodeURIComponent(this.session)}${path}`,
      body,
      signal,
      ms,
    );
  }
  async createWindow(signal: AbortSignal): Promise<string> {
    const value = await this.command("POST", "/window/new", { type: "tab" }, signal);
    if (
      !record(value) ||
      typeof value.handle !== "string" ||
      !value.handle ||
      (value.type !== "tab" && value.type !== "window")
    ) {
      this.uncertain = true;
      throw new Error("Invalid new window answer");
    }
    return value.handle;
  }
  async selectWindow(handle: string, signal: AbortSignal): Promise<void> {
    const value = await this.command("POST", "/window", { handle }, signal);
    this.emptyAnswer(value, "switch window");
  }
  async reloadWindow(signal: AbortSignal): Promise<void> {
    const value = await this.command("POST", "/refresh", undefined, signal);
    this.emptyAnswer(value, "refresh");
  }
  async closeWindow(signal: AbortSignal): Promise<void> {
    const value = await this.command("DELETE", "/window", undefined, signal);
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item)) {
      this.uncertain = true;
      throw new Error("Invalid closed window answer");
    }
  }
  private emptyAnswer(value: unknown, label: string): void {
    if (value === null) return;
    this.uncertain = true;
    throw new Error(`Invalid ${label} answer`);
  }
  async navigate(url: string, signal: AbortSignal): Promise<void> {
    await this.command("POST", "/url", { url }, signal, navigationTimeoutMs);
  }
  async handle(signal: AbortSignal): Promise<string> {
    const value = await this.command("GET", "/window", undefined, signal);
    if (typeof value !== "string" || !value) {
      this.uncertain = true;
      throw new Error("Invalid window handle");
    }
    return value;
  }
  async handles(signal: AbortSignal): Promise<string[]> {
    const value = await this.command("GET", "/window/handles", undefined, signal);
    if (
      !Array.isArray(value) ||
      !value.every((item) => typeof item === "string" && item) ||
      new Set(value).size !== value.length
    ) {
      this.uncertain = true;
      throw new Error("Invalid window handles");
    }
    return value;
  }
  async url(signal: AbortSignal): Promise<string> {
    return stringValue(await this.command("GET", "/url", undefined, signal));
  }
  script(source: string, signal: AbortSignal): Promise<unknown> {
    return this.command("POST", "/execute/sync", { script: source, args: [] }, signal);
  }
  async press(key: HostKey, control: DriverPressControl): Promise<void> {
    const value = nativeKey(key);
    const body = {
      actions: [
        {
          type: "key",
          id: "waffle-keyboard",
          actions: [
            { type: "keyDown", value },
            { type: "keyUp", value },
          ],
        },
      ],
    };
    await control.dispatch(async () => {
      const answer = await this.command("POST", "/actions", body, new AbortController().signal);
      this.emptyAnswer(answer, "key press");
    });
  }
  stop(): Promise<DriverCleanup> {
    return (this.stopping ??= this.stopOnce());
  }
  private async stopOnce(): Promise<DriverCleanup> {
    let observerFailure: unknown;
    try {
      await this.observation?.stop();
    } catch (error) {
      observerFailure = error;
    }
    let session: CleanupStep = { status: "not-created", detail: "No session created" };
    if (this.session) {
      try {
        await this.request(
          "DELETE",
          `/session/${encodeURIComponent(this.session)}`,
          undefined,
          AbortSignal.timeout(5000),
          5000,
          false,
        );
        session = { status: "confirmed", detail: `Exact session deleted; ${this.sessionIdentity}` };
      } catch (error) {
        session = { status: "unconfirmed", detail: `${String(error)}; ${this.sessionIdentity}` };
      }
    } else if (this.uncertain)
      session = {
        status: "unconfirmed",
        detail: "Session creation may have completed without an answer",
      };
    if (observerFailure)
      session = {
        status: "unconfirmed",
        detail: `Inspector observation cleanup unconfirmed: ${String(observerFailure)}; ${session.detail}`,
      };
    const launcher = await this.stopLauncher();
    const serviceDisposition =
      this.association?.kind === "launchd-service"
        ? `Launchd HTTPService ${this.association.pid} associated for requests only; system-managed service not signalled or claimed cleaned`
        : "No delegated service owned; no service signals";
    return { session, launcher, serviceDisposition };
  }
  private async stopLauncher(): Promise<CleanupStep> {
    const child = this.child;
    if (!child) return { status: "not-created", detail: "No launcher created" };
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await bounded(
        this.childExit ?? Promise.reject(new Error("Missing launcher join")),
        2000,
        "launcher SIGTERM join",
      );
      return { status: "confirmed", detail: `Direct launcher ${child.pid} joined` };
    } catch {
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await bounded(
          this.childExit ?? Promise.reject(new Error("Missing launcher join")),
          2000,
          "launcher SIGKILL join",
        );
        return { status: "confirmed", detail: `Direct launcher ${child.pid} killed and joined` };
      } catch (error) {
        return { status: "unconfirmed", detail: String(error) };
      }
    }
  }
}
