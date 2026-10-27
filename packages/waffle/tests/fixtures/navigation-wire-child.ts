import { writeFileSync, writeSync } from "node:fs";

export const wireText =
  "GET / HTTP/1.1\r\nx-waffle-navigation-id: page-1-target\r\n\r\n" +
  "HTTP/1.1 200 OK\r\nContent-Length: 53\r\n\r\n" +
  "<!doctype html><title>Process transport tests</title>";
export const captureDiagnostics = "synthetic capture warning\nlistening on lo, synthetic\n";
export const captureTail =
  "synthetic capture error\n2 packets captured\n0 packets dropped by kernel\n";

function runCapture(): void {
  if (process.env.WIRE_FILL === "1") writeSync(1, "x".repeat(600 * 1024));
  writeSync(1, wireText);
  writeSync(2, captureDiagnostics);
  process.once("SIGINT", () => {
    writeSync(2, captureTail);
    process.exit(7);
  });
  setInterval(() => {}, 1000);
}

async function runObserver(): Promise<void> {
  const observerPath = process.env.OBSERVER_PATH;
  const resultPath = process.env.RESULT_PATH;
  if (!observerPath || !resultPath) throw new Error("Missing controlled-child paths");
  const observer: typeof import("../process-navigation-observer.ts") = await import(observerPath);
  const primary = Object.freeze({ kind: "primary-interruption" });
  const interruption = Promise.withResolvers<never>();
  process.once("SIGTERM", () => interruption.reject(primary));
  const originalLog = console.log;
  let capturePid = 0;
  console.log = (label: unknown, value: unknown) => {
    if (label === "PROCESS_NAVIGATION_CAPTURE_OWNER" && typeof value === "string")
      capturePid = JSON.parse(value).pid;
    if (capturePid) process.send?.({ kind: "capture-owned", capturePid });
    originalLog(label, value);
  };
  let caught: unknown;
  try {
    await observer.startNavigationCapture(12345);
    if (process.env.WIRE_QUIET !== "1")
      observer.NavigationObservation.begin("synthetic", "retention").failed(primary);
    process.send?.({ kind: "ready", capturePid });
    await interruption.promise;
  } catch (error) {
    caught = error;
  } finally {
    await observer.stopNavigationCapture();
  }
  writeFileSync(
    resultPath,
    JSON.stringify({
      primaryPreserved: caught === primary,
      errors: observer.navigationDiagnosticErrors().map(String),
    }),
  );
  process.exitCode = caught === primary ? 23 : 24;
}

async function runSetup(): Promise<void> {
  const observerPath = process.env.OBSERVER_PATH;
  if (!observerPath) throw new Error("Missing controlled-child observer path");
  const observer: typeof import("../process-navigation-observer.ts") = await import(observerPath);
  try {
    await observer.startNavigationCapture(12345);
    if (process.env.WIRE_STRICT === "1") observer.assertNavigationCaptureReady();
  } catch (error) {
    console.error(String(error));
    process.exitCode = 24;
  } finally {
    await observer.stopNavigationCapture();
  }
}

async function runCollection(): Promise<void> {
  const path = process.env.ROOT_DIAGNOSTIC_PATH;
  const root = process.env.ROOT_NAVIGATION_EVIDENCE;
  if (!path || !root) throw new Error("Missing synthetic collection paths");
  const diagnostic: typeof import("../process-root-navigation-diagnostic.ts") = await import(path);
  await diagnostic.collectionPreflight(root);
  writeSync(1, Buffer.from([0, 255, 128, 13, 10]));
  writeSync(2, "synthetic child stderr\n");
  const interrupted = Promise.withResolvers<never>();
  const primary = new Error("synthetic primary interruption");
  process.once("SIGTERM", () => interrupted.reject(primary));
  diagnostic.durableJSON(`${root}/fixture-ready.json`, { pid: process.pid });
  const keepAlive = setInterval(() => {}, 1000);
  try {
    if (process.env.ROOT_COLLECTION_MODE === "wait") await interrupted.promise;
    throw primary;
  } catch (error) {
    writeSync(2, `${String(error)}\n`);
    process.exitCode = error === primary ? 23 : 24;
  } finally {
    clearInterval(keepAlive);
    writeSync(2, "synthetic child cleanup\n");
  }
}

async function runCollector(): Promise<void> {
  const path = process.env.ROOT_DIAGNOSTIC_PATH;
  const root = process.env.ROOT_NAVIGATION_EVIDENCE;
  if (!path || !root) throw new Error("Missing synthetic collector paths");
  const diagnostic: typeof import("../process-root-navigation-diagnostic.ts") = await import(path);
  process.exitCode = await diagnostic.collectChild(
    [process.execPath, import.meta.filename, "--collection"],
    root,
  );
}

if (import.meta.main) {
  if (process.argv.includes("--collector")) await runCollector();
  else if (process.argv.includes("--collection")) await runCollection();
  else if (process.argv.includes("--capture")) runCapture();
  else if (process.argv.includes("--setup")) await runSetup();
  else await runObserver();
}
