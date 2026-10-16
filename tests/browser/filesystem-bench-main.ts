import { SharedFilesystem } from "../src/shared-fs";
const fs = new SharedFilesystem();
const calls = ["fd_write", "fd_read", "path_open", "fd_readdir", "path_filestat_get"];
async function run(arm: string, name: string, smoke: boolean) {
  const worker = new Worker("./filesystem-bench-worker.js", { type: "module" });
  const connection = arm === "head" ? fs.fork() : undefined;
  try {
    return await new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data.result);
      worker.onerror = event => reject(new Error(event.message));
      worker.postMessage({ arm, name, n: smoke ? 50 : name === "fd_readdir" ? 100 : name === "path_open" ? 4096 : 50000, connection }, connection ? [connection.port] : []);
    });
  } finally { worker.terminate(); if (connection) fs.revoke(connection); }
}
Object.assign(globalThis, {
  async filesystemBench(round: number, smoke = false) {
    const rows = [];
    for (const arm of round % 2 ? ["head", "main"] : ["main", "head"]) for (const name of calls) rows.push(await run(arm, name, smoke));
    return rows;
  },
  disposeFilesystemBench() { fs.dispose(); },
});
