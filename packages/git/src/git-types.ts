export interface GitInvocation {
  /** Arguments after `git`, without a shell parser or executable name. */
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdout: (bytes: Uint8Array) => void | Promise<void>;
  readonly stderr: (bytes: Uint8Array) => void | Promise<void>;
}

export interface GitInstallation {
  /** Run a local command in the page. `waffle-git/program` installs the same backend on PATH. */
  run(invocation: GitInvocation): Promise<number>;
  /** Stop admission and join accepted commands; never dispose the caller's Runtime. */
  dispose(): Promise<void>;
}

export interface GitStat {
  readonly mode: number;
  readonly size: number;
  readonly ino: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly uid: number;
  readonly gid: number;
  readonly dev: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

/** The upstream promise-FS operations used by the local command backend. */
export interface GitFilesystem {
  readonly promises: {
    readFile(path: string, encoding?: string | { encoding?: string }): Promise<Uint8Array | string>;
    writeFile(path: string, data: Uint8Array | string): Promise<void>;
    unlink(path: string): Promise<void>;
    readdir(path: string): Promise<string[]>;
    mkdir(path: string): Promise<void>;
    rmdir(path: string): Promise<void>;
    stat(path: string): Promise<GitStat>;
    lstat(path: string): Promise<GitStat>;
    readlink(path: string): Promise<string>;
    symlink(target: string, path: string): Promise<void>;
  };
}
