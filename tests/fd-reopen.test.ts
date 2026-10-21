import { test } from "bun:test";
import { fdReopenCases } from "./fixtures/fd-reopen-cases.js";

for (const { label, run } of fdReopenCases()) test(label, run);
