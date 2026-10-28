import * as fs from "node:fs/promises";
import type { GitFilesystem } from "./git-types";

/** Node-compatible promise FS. Under a Waffle interpreter (Bun) this is the shared Waffle filesystem. */
export const nodeGitFilesystem: GitFilesystem = {
  promises: {
    async readFile(path, encoding) {
      const bytes = await fs.readFile(path);
      const format = typeof encoding === "string" ? encoding : encoding?.encoding;
      return format ? bytes.toString("utf8") : bytes;
    },
    writeFile: fs.writeFile,
    unlink: fs.unlink,
    readdir: fs.readdir,
    async mkdir(path) {
      await fs.mkdir(path);
    },
    rmdir: fs.rmdir,
    stat: fs.stat,
    lstat: fs.lstat,
    readlink: fs.readlink,
    symlink: fs.symlink,
  },
};
