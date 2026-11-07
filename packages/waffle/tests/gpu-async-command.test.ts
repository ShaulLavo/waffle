import { expect, test } from "bun:test";
import {
  requireCompiledAsyncNegative,
  requireCompiledAsyncResult,
  requireCompiledAsyncRevocation,
} from "./gpu-async-command.js";

test("shared command retains the original strict compiled parsers", () => {
  expect(() => requireCompiledAsyncResult({ exit: { kind: "exited", code: 0 }, text: "GPU_ASYNC_OK", errors: [] })).toThrow("Missing compiled result marker");
  expect(() => requireCompiledAsyncNegative({ exit: { kind: "exited", code: 1 }, text: "GPU_ASYNC_TERMINAL reason=20\nGPU_ASYNC_FAIL stage=completion-correlation", errors: [] }, "--malformed-map")).toThrow("Missing protocol terminal");
  expect(() => requireCompiledAsyncRevocation({ exit: { kind: "exited", code: 0 }, text: "GPU_ASYNC_PAUSED stage=map-pending\nGPU_ASYNC_REVOKED stage=map-pending errno=-64 repeated=2 append=-64 drained=65", errors: [] }, "map-pending")).toThrow("Missing exact compiled revocation proof");
});
