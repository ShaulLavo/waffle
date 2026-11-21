import { runThreadsRuntime } from "./threads-runtime-browser.js";

const selected = process.argv[2];
if (selected !== "read" && selected !== "write") throw new Error("expected read or write");
const result = await runThreadsRuntime(selected === "read" ? "fd-read" : "fd-write", true);
console.log(JSON.stringify(result));
