import type { Page } from "playwright";
import { format } from "node:util";

type DebugLog = (this: { namespace?: string } | undefined, ...args: unknown[]) => void;
type PlaywrightDebug = {
  enable(namespaces: string): void;
  namespaces: string;
  log: DebugLog;
};
const browserPrefix = "pw:browser ";
const colorReset = "\x1b[0m";
const nativeOutput = /^\[pid=\d+\]\[(?:out|err)\] /;
const nativeOutputLimit = 64 * 1024;
const nativeOutputTruncated = `pw:browser native stdout/stderr truncated (limit ${nativeOutputLimit} bytes)`;
const callLogDim = "\x1b[2m";
const callLogPrefix = /^ *(?:(?:-|\d+ ×) )?/;

function isNativeOutput(line: string): boolean {
  const index = line.indexOf(browserPrefix);
  if (index === -1) return false;
  const start = index + browserPrefix.length;
  return nativeOutput.test(
    line.slice(start + (line.startsWith(colorReset, start) ? colorReset.length : 0)),
  );
}

function isReplayedNativeOutput(line: string): boolean {
  const plain = line.startsWith(callLogDim) ? line.slice(callLogDim.length) : line;
  return nativeOutput.test(plain.replace(callLogPrefix, ""));
}

export function boundWebKitLogReplay(message: string): string {
  if (!message.includes("[pid=")) return message;
  let bytes = 0;
  let truncated = false;
  const lines: string[] = [];
  for (const line of message.split("\n")) {
    if (!isReplayedNativeOutput(line)) {
      lines.push(line);
      continue;
    }
    if (truncated) continue;
    bytes += Buffer.byteLength(line) + 1;
    truncated = bytes > nativeOutputLimit;
    lines.push(truncated ? nativeOutputTruncated : line);
  }
  return truncated ? lines.join("\n") : message;
}

export function boundWebKitError(error: unknown): void {
  if (!(error instanceof Error) || !error.message.includes("[pid=")) return;
  const original = error.message;
  const message = boundWebKitLogReplay(original);
  if (message !== original) {
    const stack = error.stack;
    error.message = message;
    if (stack) error.stack = boundWebKitLogReplay(stack);
  }
  if (original.includes("\nCall log:\n") && "log" in error && Array.isArray(error.log)) {
    // Playwright puts the call log in the message and on the Error object.
    error.log = error.log.filter(
      (line: unknown) => typeof line !== "string" || !isReplayedNativeOutput(line),
    );
  }
}

export function captureWebKitDiagnostics(): () => void {
  // Playwright's bundled debug instance supplies the namespace as the log receiver.
  const { debug }: { debug: PlaywrightDebug } = require("playwright-core/lib/utilsBundle");
  const { namespaces, log } = debug;
  debug.enable(namespaces ? `${namespaces},pw:browser` : "pw:browser");
  let bytes = 0;
  let truncated = false;
  debug.log = function (...args) {
    const first = args[0];
    if (this?.namespace !== "pw:browser" || typeof first !== "string" || !isNativeOutput(first)) {
      log.apply(this, args);
      return;
    }
    if (truncated) return;
    const line = `${format(...args)}\n`;
    bytes += Buffer.byteLength(line);
    if (bytes <= nativeOutputLimit) process.stderr.write(line);
    else {
      truncated = true;
      process.stderr.write(`${nativeOutputTruncated}\n`);
    }
  };
  return () => {
    debug.log = log;
    debug.enable(namespaces ?? "");
  };
}

export function observeWebKitPage(page: Page, control: string) {
  let phase = "opened";
  let shuttingDown = false;
  const report = (event: "close" | "crash" | "failure") => {
    console.error(
      JSON.stringify({
        webkitPage: control,
        event,
        phase,
        url: page.url().split("?")[0],
        closed: page.isClosed(),
        browserConnected: page.context().browser()?.isConnected() ?? null,
      }),
    );
  };
  page.once("close", () => report("close"));
  page.once("crash", () => report("crash"));
  return {
    enter(next: string) {
      if (shuttingDown) return;
      phase = next;
    },
    shutdown(next: string) {
      shuttingDown = true;
      phase = next;
    },
    fail() {
      report("failure");
    },
  };
}
