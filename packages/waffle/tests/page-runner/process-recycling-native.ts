import { readFile } from "node:fs/promises";
import { nativeMain, writeResult } from "waffle/testing/page-runner";
import { record } from "./protocol.js";
import { processRecyclingAdapter } from "./process-recycling-suite.js";

export async function processRecyclingNative(args: string[], startedAt: number): Promise<number> {
  if (process.env.PROCESS_NAVIGATION_WIRE === "1") {
    console.error(
      "Process native wire capture is unsupported: Linux tcpdump loopback capture is not an iOS page-owned operation",
    );
    return 3;
  }
  const previousScratch = process.env.STORAGE_SCRATCH_ROOT;
  if (process.env.PROCESS_SCRATCH_ROOT) process.env.STORAGE_SCRATCH_ROOT = process.env.PROCESS_SCRATCH_ROOT;
  let exit: number;
  try {
    exit = await nativeMain(processRecyclingAdapter, args, {
      startedAt,
      filter: process.env.PROCESS_TEST_FILTER,
    });
  } finally {
    if (previousScratch === undefined) delete process.env.STORAGE_SCRATCH_ROOT;
    else process.env.STORAGE_SCRATCH_ROOT = previousScratch;
  }
  if (exit === 0 || exit === 3) return exit;
  const resultPath = args[1];
  if (!resultPath) return exit;
  try {
    const result: unknown = JSON.parse(await readFile(resultPath, "utf8"));
    if (!record(result)) throw new Error("Missing process command result");
    await writeResult(`${resultPath}.diagnostics.json`, {
      observation:
        "Actual page reports and fixture stacks only; no native navigation, network or Worker-close trace is available",
      ...result,
    });
  } catch (error) {
    console.error("Process failure diagnostics could not be saved", error);
    return 2;
  }
  return exit;
}
