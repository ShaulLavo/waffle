const startedAt = performance.now();
const { requireCompiledAsyncResult, requireCompiledAsyncNegative, requireCompiledAsyncRevocation } =
  await import("./gpu-async-command.js");
export { requireCompiledAsyncResult, requireCompiledAsyncNegative, requireCompiledAsyncRevocation };

export async function runCompiledAsync(
  engines: readonly string[],
  entered = performance.now(),
): Promise<void> {
  const desktop = await import("./gpu-async-desktop.js");
  await desktop.runCompiledAsync(engines, entered);
}
if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("ios-safari")) {
    const { gpuAsyncNative } = await import("./page-runner/gpu-async-native.js");
    process.exitCode =
      args[0] === "ios-safari" ? await gpuAsyncNative(args.slice(1), startedAt) : 3;
  } else await runCompiledAsync(args.length ? args : ["chromium"], startedAt);
}
