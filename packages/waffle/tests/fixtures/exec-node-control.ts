import { runExecIntegration } from "./exec-integration.js";
import { installExecNodeWorkers } from "./exec-node-host.js";

const mode = process.argv[2];
if (
  mode !== "replace" &&
  mode !== "twice" &&
  mode !== "preopen-remap" &&
  mode !== "omit-preopen" &&
  mode !== "capacity-exec" &&
  mode !== "capacity-control"
)
  throw new Error("unknown exec integration mode");
const restore = installExecNodeWorkers();
try {
  console.log(JSON.stringify(await runExecIntegration({ mode, workerUrl: process.argv[3]! })));
} finally {
  restore();
}
