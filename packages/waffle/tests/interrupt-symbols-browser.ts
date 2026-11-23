import { describeWorkerError } from "../browser/worker.js";
import { CacheStorageAdmittedStore } from "../interrupt/admitted-store.js";
import { admittedModuleDiagnostics, InterruptModuleCache } from "../interrupt/loader.js";
import { prepareLinkPlan } from "../link/index.js";
import {
  alreadyNamedGuestModule,
  echoSizedGuestFixture,
  helperGuestModule,
  linkedGroupTrapSource,
  supervisedTrapGuestModule,
  trapGuestModule,
} from "./fixtures/interrupt-symbols-wasm.js";
import type {
  SymbolsWorkerRequest,
  WorkerTrapResult,
} from "./fixtures/interrupt-symbols-worker.js";

interface SidecarManifestEntry {
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
}

export interface BrowserSidecarManifest {
  readonly guestA: SidecarManifestEntry;
  readonly guestB: SidecarManifestEntry;
  readonly supervised: SidecarManifestEntry;
  readonly wrongSource: SidecarManifestEntry;
  readonly malformed: SidecarManifestEntry;
  readonly emptyName: SidecarManifestEntry;
  readonly missing: SidecarManifestEntry;
  readonly disabledSentinel: SidecarManifestEntry;
  readonly echoSized: SidecarManifestEntry;
}

export interface BrowserSymbolsReport {
  readonly userAgent: string;
  readonly namedAfterMiss: number;
  readonly namedAfterCacheHit: number;
  readonly cacheHitReusedDistinctNonce: boolean;
  readonly supervisedNamed: number;
  readonly wrongDigestAnnotated: number;
  readonly wrongBytesAnnotated: number;
  readonly wrongSourceAnnotated: number;
  readonly malformedJsonAnnotated: number;
  readonly emptyNameAnnotated: number;
  readonly missingSidecarAnnotated: number;
  readonly disabledFetches: number;
  readonly disabledAnnotated: number;
  readonly multiModuleHelperAnnotated: number;
  readonly multiModuleStreamingHelperAnnotated: number;
  readonly multiModuleTwoAdmittedAnnotated: number;
  readonly linkedGroupAnnotated: number;
  readonly alreadyNamedAnnotated: number;
  readonly mixedAlreadyNamedAnnotated: number;
  readonly truncatedLimit5Annotated: number;
  readonly midLineTruncatedAnnotated: number;
  readonly workerHeaderPreservedUnreachableFrame: boolean;
  readonly overhead: {
    readonly sidecarBytes: number;
    readonly loadTableMs: number;
    readonly annotateStackMs: number;
    readonly annotatedFrames: number;
  };
}

function check(condition: unknown, detail: string): asserts condition {
  if (!condition) throw new Error(detail);
}

async function trapInWorker(request: SymbolsWorkerRequest): Promise<WorkerTrapResult> {
  const worker = new Worker("/worker.js", { type: "module" });
  try {
    return await new Promise<WorkerTrapResult>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`worker timeout: ${request.mode}`)), 15_000);
      worker.onerror = (event) => {
        clearTimeout(timer);
        reject(new Error(`worker error: ${event.message}`));
      };
      worker.onmessage = ({
        data,
      }: MessageEvent<{ ok: boolean; result?: WorkerTrapResult; error?: unknown }>) => {
        clearTimeout(timer);
        if (!data.ok || !data.result) {
          reject(new Error(`worker failed: ${JSON.stringify(data.error)}`));
          return;
        }
        resolve(data.result);
      };
      worker.postMessage(request);
    });
  } finally {
    worker.terminate();
  }
}

function fakeErrorFromTrap(trap: WorkerTrapResult): WebAssembly.RuntimeError {
  const err = new WebAssembly.RuntimeError(trap.message);
  err.stack = trap.rawStack;
  return err;
}

/** @browserEntry End-to-end Wasm trap symbol recovery across all failure and isolation controls. */
export async function runInterruptSymbolsBrowser(
  manifest: BrowserSidecarManifest,
): Promise<BrowserSymbolsReport> {
  for (const key of await caches.keys()) await caches.delete(key);

  const sourceA = trapGuestModule(1);
  const sourceB = trapGuestModule(2);
  const supSource = supervisedTrapGuestModule();
  const echoFixture = echoSizedGuestFixture();
  const store = new CacheStorageAdmittedStore(caches, location.origin);

  try {
    // 1. Diagnostics disabled first: populates canonical CacheStorage and fetches nothing.
    const disabledMissCache = new InterruptModuleCache(16, store);
    const disabledMod = await disabledMissCache.compile(sourceA, "ordinary");
    check(admittedModuleDiagnostics(disabledMod) === undefined, "disabled miss recorded facts");
    const disabledTrap = await trapInWorker({
      mode: "direct",
      module: disabledMod,
      action: "start",
    });

    // Dynamically load the lazy annotator only once we enter diagnostic checks.
    const { annotateError, annotateStack, loadSymbolTable } =
      await import("../interrupt/symbols.js");

    let disabledFetches = 0;
    const disabledErr = fakeErrorFromTrap(disabledTrap);
    const disabledRes = await annotateError(
      disabledErr,
      [{ module: disabledMod, sidecar: manifest.disabledSentinel }],
      {
        fetch: (input, init) => {
          disabledFetches++;
          return fetch(input, init);
        },
      },
    );
    check(disabledFetches === 0, `disabled diagnostics fetched ${disabledFetches} times`);
    check(disabledRes.error === disabledErr, "disabled annotateError replaced error");
    check(disabledRes.stack === disabledTrap.rawStack, "disabled annotateError mutated stack");
    check(disabledRes.annotatedFrames === 0, "disabled annotateError annotated frames");

    // 2. Opt-in diagnostics enabled: miss and CacheStorage hit both name frames cleanly.
    const diagCacheA = new InterruptModuleCache(16, store, {}, { symbolDiagnostics: true });
    const modAHit = await diagCacheA.compile(sourceA, "ordinary");
    const factsAHit = admittedModuleDiagnostics(modAHit);
    check(factsAHit !== undefined, "diagnostic CacheStorage hit missing facts");

    // Compile sourceA on a fresh cache with no store to exercise the diagnostic cache-miss path.
    const diagMissCache = new InterruptModuleCache(16, null, {}, { symbolDiagnostics: true });
    const modAMiss = await diagMissCache.compile(sourceA, "ordinary");
    const factsAMiss = admittedModuleDiagnostics(modAMiss);
    check(factsAMiss !== undefined, "diagnostic miss missing facts");
    const cacheHitReusedDistinctNonce = factsAMiss.nonce !== factsAHit.nonce;
    check(cacheHitReusedDistinctNonce, "cache miss and cache hit reused the same nonce");

    const trapMiss = await trapInWorker({ mode: "direct", module: modAMiss, action: "start" });
    const errMiss = fakeErrorFromTrap(trapMiss);
    const resMiss = await annotateError(errMiss, [{ module: modAMiss, sidecar: manifest.guestA }]);
    check(resMiss.error === errMiss, "miss annotateError replaced original error");
    check(errMiss.stack === trapMiss.rawStack, "miss annotateError mutated original error stack");
    check(resMiss.annotatedFrames === 3, `expected 3 miss frames, got ${resMiss.annotatedFrames}`);
    for (const symbol of ["inner_trap", "outer", "_start"]) {
      check(resMiss.stack.includes(symbol), `miss stack missing ${symbol}: ${resMiss.stack}`);
    }

    // CacheStorage hit trap annotation
    const trapHit = await trapInWorker({ mode: "direct", module: modAHit, action: "start" });
    const resHit = await annotateError(fakeErrorFromTrap(trapHit), [
      { module: modAHit, sidecar: manifest.guestA },
    ]);
    check(resHit.annotatedFrames === 3, `expected 3 hit frames, got ${resHit.annotatedFrames}`);
    for (const symbol of ["inner_trap", "outer", "_start"]) {
      check(resHit.stack.includes(symbol), `hit stack missing ${symbol}: ${resHit.stack}`);
    }

    // Null entry in sidecar (div0 definition is left null in guestA sidecar) stays raw!
    const div0Trap = await trapInWorker({ mode: "direct", module: modAHit, action: "div0" });
    const div0Res = await annotateError(fakeErrorFromTrap(div0Trap), [
      { module: modAHit, sidecar: manifest.guestA },
    ]);
    check(
      div0Res.annotatedFrames === 0 && div0Res.stack === div0Trap.rawStack,
      `null-named definition should stay raw: ${div0Res.stack}`,
    );

    // Supervised-thread +3 shift
    const supMod = await diagCacheA.compile(supSource, "supervised-thread");
    const supTrap = await trapInWorker({ mode: "direct", module: supMod, action: "start" });
    const supRes = await annotateError(fakeErrorFromTrap(supTrap), [
      { module: supMod, sidecar: manifest.supervised },
    ]);
    check(
      supRes.annotatedFrames === 2,
      `expected 2 supervised frames, got ${supRes.annotatedFrames}`,
    );
    check(
      supRes.stack.includes("sup_inner_trap") && supRes.stack.includes("sup_start"),
      `supervised stack missing expected names: ${supRes.stack}`,
    );

    // 3. Failure paths: wrong digest, wrong bytes, wrong source hash, malformed JSON, empty name, missing sidecar.
    const checkFailClosed = async (
      label: string,
      sidecar: { readonly url: string; readonly bytes?: number; readonly sha256: string },
    ) => {
      const err = fakeErrorFromTrap(trapMiss);
      const res = await annotateError(err, [{ module: modAMiss, sidecar }]);
      check(res.error === err, `${label}: replaced original error`);
      check(res.stack === trapMiss.rawStack, `${label}: altered raw stack`);
      check(res.annotatedFrames === 0, `${label}: annotated ${res.annotatedFrames} frames`);
      return res.annotatedFrames;
    };

    const wrongDigestAnnotated = await checkFailClosed("wrong-digest", {
      url: manifest.guestA.url,
      bytes: manifest.guestA.bytes,
      sha256: "0".repeat(64),
    });
    const wrongBytesAnnotated = await checkFailClosed("wrong-bytes", {
      url: manifest.guestA.url,
      bytes: manifest.guestA.bytes + 1,
      sha256: manifest.guestA.sha256,
    });
    const wrongSourceAnnotated = await checkFailClosed("wrong-source", manifest.wrongSource);
    const malformedJsonAnnotated = await checkFailClosed("malformed-json", manifest.malformed);
    const emptyNameAnnotated = await checkFailClosed("empty-name", manifest.emptyName);
    const missingSidecarAnnotated = await checkFailClosed("missing-sidecar", manifest.missing);

    // 4. Multi-module stacks: helper, streaming named helper, two admitted modules, linked 3-module group.
    const helperMod = await WebAssembly.compile(helperGuestModule(102));
    const streamingHelperMod = await WebAssembly.compileStreaming(fetch("/helper-named.wasm"));
    const modB = await diagCacheA.compile(sourceB, "ordinary");

    const bridgeHelperTrap = await trapInWorker({
      mode: "bridge",
      primary: modAMiss,
      secondary: helperMod,
      secondaryEntry: "helper_outer",
    });
    const bridgeHelperRes = await annotateError(fakeErrorFromTrap(bridgeHelperTrap), [
      { module: modAMiss, sidecar: manifest.guestA },
    ]);
    check(
      bridgeHelperRes.annotatedFrames === 1 && bridgeHelperRes.stack.includes("call_bridge"),
      `helper bridge should name only call_bridge: ${bridgeHelperRes.stack}`,
    );

    const bridgeStreamTrap = await trapInWorker({
      mode: "bridge",
      primary: modAMiss,
      secondary: streamingHelperMod,
      secondaryEntry: "helper_outer",
    });
    const bridgeStreamRes = await annotateError(fakeErrorFromTrap(bridgeStreamTrap), [
      { module: modAMiss, sidecar: manifest.guestA },
    ]);
    check(
      bridgeStreamRes.annotatedFrames === 1 && bridgeStreamRes.stack.includes("call_bridge"),
      `streaming helper bridge should name only call_bridge: ${bridgeStreamRes.stack}`,
    );

    const bridgeTwoTrap = await trapInWorker({
      mode: "bridge",
      primary: modAMiss,
      secondary: modB,
      secondaryEntry: "outer",
    });
    const bridgeTwoRes = await annotateError(fakeErrorFromTrap(bridgeTwoTrap), [
      { module: modAMiss, sidecar: manifest.guestA },
      { module: modB, sidecar: manifest.guestB },
    ]);
    check(
      bridgeTwoRes.annotatedFrames === 3 &&
        bridgeTwoRes.stack.includes("call_bridge") &&
        bridgeTwoRes.stack.includes("outer_b") &&
        bridgeTwoRes.stack.includes("inner_trap_b"),
      `two admitted modules stack mismatch: ${bridgeTwoRes.stack}`,
    );

    const linkedPlan = await prepareLinkPlan(linkedGroupTrapSource());
    const linkedTrap = await trapInWorker({ mode: "linked", plan: linkedPlan.shared });
    const tableA = await loadSymbolTable(modAMiss, manifest.guestA);
    check(tableA !== undefined, "failed to load valid tableA");
    const linkedRes = annotateStack(linkedTrap.rawStack, [tableA]);
    check(
      linkedRes.annotatedFrames === 0 && linkedRes.stack === linkedTrap.rawStack,
      `linked group frames must stay raw: ${linkedRes.stack}`,
    );

    // 5. Already-named frames (standalone & mixed) + idempotency.
    const namedWithMod = await WebAssembly.compile(alreadyNamedGuestModule("already_mod"));
    const namedTrap = await trapInWorker({ mode: "direct", module: namedWithMod, action: "start" });
    const namedRes = annotateStack(namedTrap.rawStack, [tableA]);
    check(
      namedRes.annotatedFrames === 0 && namedRes.stack === namedTrap.rawStack,
      `already-named stack altered: ${namedRes.stack}`,
    );

    const namedNoMod = await WebAssembly.compile(alreadyNamedGuestModule(undefined));
    const mixedTrap = await trapInWorker({
      mode: "bridge",
      primary: modAMiss,
      secondary: namedNoMod,
      secondaryEntry: "run",
    });
    const mixedRes = annotateStack(mixedTrap.rawStack, [tableA]);
    check(
      mixedRes.annotatedFrames === 1 &&
        mixedRes.stack.includes("call_bridge") &&
        mixedRes.stack.includes("weird:trap (inner)"),
      `mixed already-named stack mismatch: ${mixedRes.stack}`,
    );
    check(
      annotateStack(resMiss.stack, [tableA]).annotatedFrames === 0,
      "annotation not idempotent",
    );

    // 6. Truncated stacks (Error.stackTraceLimit = 5, mid-line truncation) + workerErrorText fix.
    const truncTrap = await trapInWorker({
      mode: "direct",
      module: modAMiss,
      action: "recurse",
      depth: 25,
      stackTraceLimit: 5,
    });
    const truncRes = annotateStack(truncTrap.rawStack, [tableA]);
    check(
      truncRes.annotatedFrames === 5 && truncRes.stack.includes("recurse"),
      `expected 5 annotated truncated frames, got ${truncRes.annotatedFrames}`,
    );

    const lines = trapMiss.rawStack.split("\n");
    const targetIdx = lines.findIndex((line) => line.includes("wasm-function[5]"));
    check(targetIdx >= 0, "missing wasm-function[5] in raw stack");
    const midTruncatedLine = `${lines[targetIdx]!.slice(0, -4)}... [truncated]`;
    lines[targetIdx] = midTruncatedLine;
    const midRes = annotateStack(lines.join("\n"), [tableA]);
    check(
      midRes.annotatedFrames === 2 && midRes.stack.includes(midTruncatedLine),
      `mid-line truncation mismatch (${midRes.annotatedFrames}): ${midRes.stack}`,
    );

    // 7. Realistic ~80 KiB Echo-sized sidecar lookup overhead + workerErrorText header preservation.
    const echoMod = await diagCacheA.compile(echoFixture.wasm, "ordinary");
    const echoTrap = await trapInWorker({ mode: "direct", module: echoMod, action: "start" });
    const t0 = performance.now();
    const echoTable = await loadSymbolTable(echoMod, manifest.echoSized);
    const t1 = performance.now();
    check(echoTable !== undefined, "echo-sized sidecar failed to load");
    const echoAnnotated = annotateStack(echoTrap.rawStack, [echoTable]);
    const t2 = performance.now();
    check(
      echoAnnotated.annotatedFrames === 2 &&
        echoAnnotated.stack.includes("echo_trap_unreachable") &&
        echoAnnotated.stack.includes("_start"),
      `echo-sized stack mismatch: ${echoAnnotated.stack}`,
    );

    const annotatedErr = new WebAssembly.RuntimeError("unreachable");
    annotatedErr.stack = echoAnnotated.stack;
    const described = describeWorkerError(annotatedErr);
    const workerHeaderPreservedUnreachableFrame = described.includes("echo_trap_unreachable");
    check(
      workerHeaderPreservedUnreachableFrame,
      `describeWorkerError dropped echo_trap_unreachable: ${described}`,
    );

    return {
      userAgent: navigator.userAgent,
      namedAfterMiss: resMiss.annotatedFrames,
      namedAfterCacheHit: resHit.annotatedFrames,
      cacheHitReusedDistinctNonce,
      supervisedNamed: supRes.annotatedFrames,
      wrongDigestAnnotated,
      wrongBytesAnnotated,
      wrongSourceAnnotated,
      malformedJsonAnnotated,
      emptyNameAnnotated,
      missingSidecarAnnotated,
      disabledFetches,
      disabledAnnotated: disabledRes.annotatedFrames,
      multiModuleHelperAnnotated: bridgeHelperRes.annotatedFrames,
      multiModuleStreamingHelperAnnotated: bridgeStreamRes.annotatedFrames,
      multiModuleTwoAdmittedAnnotated: bridgeTwoRes.annotatedFrames,
      linkedGroupAnnotated: linkedRes.annotatedFrames,
      alreadyNamedAnnotated: namedRes.annotatedFrames,
      mixedAlreadyNamedAnnotated: mixedRes.annotatedFrames,
      truncatedLimit5Annotated: truncRes.annotatedFrames,
      midLineTruncatedAnnotated: midRes.annotatedFrames,
      workerHeaderPreservedUnreachableFrame,
      overhead: {
        sidecarBytes: manifest.echoSized.bytes,
        loadTableMs: Number((t1 - t0).toFixed(3)),
        annotateStackMs: Number((t2 - t1).toFixed(3)),
        annotatedFrames: echoAnnotated.annotatedFrames,
      },
    };
  } finally {
    for (const key of await caches.keys()) await caches.delete(key);
  }
}
