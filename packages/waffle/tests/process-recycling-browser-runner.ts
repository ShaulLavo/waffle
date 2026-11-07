// Capture the command clock before importing the native host or any fixture producer.
const startedAt = performance.now();
if (process.argv[2] === "ios-safari") {
  const { processRecyclingNative } = await import("./page-runner/process-recycling-native.js");
  process.exit(await processRecyclingNative(process.argv.slice(3), startedAt));
}
if (process.argv[2] === "--page-controls") {
  const { processRecyclingControls } = await import("./page-runner/process-recycling-controls.js");
  await processRecyclingControls(process.argv.slice(3));
} else {
  await import("./process-recycling-desktop-runner.js");
}
