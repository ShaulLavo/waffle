import { nativeMain } from "waffle/testing/page-runner";
import { keyPressAdapter } from "./key-press-suite.js";

if (import.meta.main)
  process.exitCode = await nativeMain(keyPressAdapter(), process.argv.slice(2), {
    scratchRoot: process.env.STORAGE_SCRATCH_ROOT,
  });
