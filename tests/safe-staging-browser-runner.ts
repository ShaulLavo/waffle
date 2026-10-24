import { runSafeStagingNative } from "./safe-staging-native.js";

const names = process.argv.slice(2);
for (const name of names.length ? names : ["chromium", "firefox", "webkit"])
  await runSafeStagingNative(name, process.env.SAFE_STAGING_CONTROL);
