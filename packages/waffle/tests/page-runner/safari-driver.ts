import { openSync, closeSync } from "node:fs";
import { join } from "node:path";
import {
  bounded,
  parseSession,
  stringValue,
  type Driver,
  type DriverCleanup,
  type CleanupStep,
} from "./driver.js";
import { record } from "./protocol.js";
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
async function tool(args: string[], allowMissing = false): Promise<string> {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "ignore" });
  try {
    const [text, exit] = await bounded(
      Promise.all([new Response(child.stdout).text(), child.exited]),
      2000,
      args[0] ?? "tool",
    );
    if (exit !== 0 && !allowMissing) throw new Error(`${args[0]} exited ${exit}`);
    return exit === 0 ? text : "";
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await bounded(child.exited, 1000, "observation tool exit");
    }
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
  if (
    pids.length !== 1 ||
    !lines.some((line) =>
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
  private child: ReturnType<typeof Bun.spawn> | undefined;
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
  ) {}
  async start(signal: AbortSignal): Promise<void> {
    const reservation = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    this.port = reservation.port;
    reservation.stop(true);
    this.base = `http://127.0.0.1:${this.port}`;
    const log = openSync(join(this.scratch, "safaridriver.log"), "w");
    try {
      this.child = Bun.spawn(["/usr/bin/safaridriver", "-p", String(this.port)], {
        stdin: "ignore",
        stdout: log,
        stderr: log,
      });
    } finally {
      closeSync(log);
    }
    await this.ready(signal);
    const value = await this.request(
      "POST",
      "/session",
      {
        capabilities: {
          alwaysMatch: {
            browserName: "Safari",
            platformName: "iOS",
            "safari:useSimulator": true,
            "safari:deviceUDID": this.udid,
          },
        },
      },
      signal,
    );
    this.session = parseSession(value);
    this.sessionIdentity = returnedIdentity(value, this.session);
    nativeCapabilities(value, this.udid);
    await this.command(
      "POST",
      "/timeouts",
      { implicit: 0, pageLoad: 15_000, script: 3000 },
      signal,
    );
  }
  private async observe(): Promise<Association | null> {
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
      child.pid,
      this.port,
      process.getuid?.() ?? -1,
    );
  }
  private async ready(signal: AbortSignal): Promise<void> {
    const until = performance.now() + 15_000;
    while (performance.now() < until) {
      signal.throwIfAborted();
      const first = await this.observe();
      if (first && (await this.confirm(first, signal))) return;
      await Bun.sleep(100);
    }
    throw new Error("SafariDriver listener association/readiness unavailable");
  }
  private async confirm(first: Association, signal: AbortSignal): Promise<boolean> {
    try {
      await this.request("GET", "/status", undefined, signal, 1000, false);
      const again = await this.observe();
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
    try {
      const response = await fetch(this.base + path, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(ms)]),
      });
      const answer: unknown = await response.json();
      if (!record(answer) || !response.ok || !Object.hasOwn(answer, "value"))
        throw new Error(`WebDriver ${path}: ${JSON.stringify(answer)}`);
      if (record(answer.value) && typeof answer.value.error === "string")
        throw new Error(`WebDriver ${path}: ${JSON.stringify(answer.value)}`);
      return answer.value;
    } catch (error) {
      if (marksUncertain) this.uncertain = true;
      throw error;
    }
  }
  private command(
    method: string,
    path: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (!this.session) throw new Error("No owned WebDriver session");
    if (this.uncertain) throw new Error("Uncertain WebDriver completion, dispatch stopped");
    return this.request(
      method,
      `/session/${encodeURIComponent(this.session)}${path}`,
      body,
      signal,
    );
  }
  async navigate(url: string, signal: AbortSignal): Promise<void> {
    await this.command("POST", "/url", { url }, signal);
  }
  async handle(signal: AbortSignal): Promise<string> {
    return stringValue(await this.command("GET", "/window", undefined, signal));
  }
  async handles(signal: AbortSignal): Promise<string[]> {
    const value = await this.command("GET", "/window/handles", undefined, signal);
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
      throw new Error("Invalid window handles");
    return value;
  }
  async url(signal: AbortSignal): Promise<string> {
    return stringValue(await this.command("GET", "/url", undefined, signal));
  }
  script(source: string, signal: AbortSignal): Promise<unknown> {
    return this.command("POST", "/execute/sync", { script: source, args: [] }, signal);
  }
  stop(): Promise<DriverCleanup> {
    return (this.stopping ??= this.stopOnce());
  }
  private async stopOnce(): Promise<DriverCleanup> {
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
      await bounded(child.exited, 2000, "launcher SIGTERM join");
      return { status: "confirmed", detail: `Direct launcher ${child.pid} joined` };
    } catch {
      try {
        child.kill("SIGKILL");
        await bounded(child.exited, 2000, "launcher SIGKILL join");
        return { status: "confirmed", detail: `Direct launcher ${child.pid} killed and joined` };
      } catch (error) {
        return { status: "unconfirmed", detail: String(error) };
      }
    }
  }
}
