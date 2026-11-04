import { runThreadsRuntime, type RuntimeThreadCase } from "./threads-runtime-browser.js";
const selected = process.argv[2];
if (
  selected !== "kill-start" &&
  selected !== "join" &&
  selected !== "child-exit" &&
  selected !== "cpu" &&
  selected !== "wait32" &&
  selected !== "wait64"
)
  throw new Error("expected a generated Runtime kill case");
const report = await runThreadsRuntime(selected satisfies RuntimeThreadCase, true);
console.log(JSON.stringify(report));
