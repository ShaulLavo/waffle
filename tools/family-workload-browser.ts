import assert from "node:assert/strict";
import { resolve } from "node:path";
import { familyBrowser, runPackedWorkload } from "./family-browser-runner.ts";

const [engine, output] = process.argv.slice(2);
assert.ok(engine && output, "Expected a browser and report path");
const consumer = process.cwd();
const report = await runPackedWorkload(
  consumer,
  resolve(consumer, "acceptance.js"),
  familyBrowser(engine),
);
await Bun.write(output, JSON.stringify(report));
