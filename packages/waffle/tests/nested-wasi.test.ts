import { test } from "bun:test";
import { nestedWasi } from "./fixtures/nested-wasi.js";

for (const shared of [false, true])
  test(`nested native WASI I/O survives memory growth and context exit (shared=${shared})`, () => {
    nestedWasi(shared);
  });
