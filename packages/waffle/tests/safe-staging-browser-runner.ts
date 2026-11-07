import { runSafeStagingNative } from "./safe-staging-native.js";

if (process.argv[2] === "ios-safari") {
  const startedAt = performance.now();
  const { nativeMain } = await import("./page-runner/native.js");
  const { safeStagingAdapter } = await import("./page-runner/safe-staging-suite.js");
  const selected = process.env.SAFE_STAGING_CONTROL || undefined;
  process.exit(
    await nativeMain(safeStagingAdapter(selected), process.argv.slice(3), {
      startedAt,
      filter: selected ? "safeStagingNative" : undefined,
    }),
  );
}
if (process.argv[2] === "--page-controls") {
  const { runSafeStagingControls } = await import("./page-runner/safe-staging-controls-runner.js");
  await runSafeStagingControls(process.argv[3] ?? "chromium");
  process.exit(0);
}
const names = process.argv.slice(2);
for (const name of names.length ? names : ["chromium", "firefox", "webkit"])
  await runSafeStagingNative(name, process.env.SAFE_STAGING_CONTROL);
