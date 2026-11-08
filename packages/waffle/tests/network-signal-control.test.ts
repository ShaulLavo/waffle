import { test } from "bun:test";
import { signalControl } from "./network-signal-controls.js";
for (const signal of ["SIGINT", "SIGTERM"] as const)
  test.skipIf(process.env.WAFFLE_NETWORK_SIGNAL_CONTROL !== "1")(
    `${signal} joins real pending callback before close, result and process return`,
    () => signalControl(signal),
    45_000,
  );
