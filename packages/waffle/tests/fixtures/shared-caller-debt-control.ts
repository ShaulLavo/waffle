import { sharedCallerExec, type SharedExecMode } from "./shared-caller-exec.js";

const modes: SharedExecMode[] = [
  "native-failure",
  "filesystem-failure",
  "controller-failure",
  "cleanup-failure",
];
const mode = modes.find((entry) => entry === process.argv[2]);
if (!mode) throw new Error("expected a shared exec cleanup failure mode");
console.log(JSON.stringify(await sharedCallerExec(mode)));
