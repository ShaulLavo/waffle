import { RIGHTS_ALL, RIGHT_FD_READ } from "../../core/rights.js";
import { FilesystemClient, type FilesystemConnection } from "../../fs/index.js";
import { countingFs, createPathOpenHost, type FsCounts } from "./wasi-path-open-host.js";

/** Non-rooted guests over a real FilesystemClient: `volume` binds `/` to `/volume`, `aliased`
 * binds the filesystem root under `/work`. Reports what each open saw and whether the shared
 * epoch moved. */
export interface RootIdentityReport {
  epochBefore: number;
  epochAfter: number;
  opens: { label: string; errno: number; text?: string; kind?: string; counts: FsCounts }[];
}

self.onmessage = ({
  data,
}: MessageEvent<{ connection: FilesystemConnection; layout: "volume" | "aliased" }>) => {
  const client = new FilesystemClient(data.connection);
  const wrapped = countingFs(client);
  const preopens: Record<string, string> =
    data.layout === "volume" ? { "/": "/volume" } : { "/work": "/" };
  const host = createPathOpenHost(wrapped.fs, preopens);
  const opens: RootIdentityReport["opens"] = [];
  const open = (label: string, dirfd: number, path: string) => {
    wrapped.reset();
    const opened = host.openRaw(dirfd, path, { base: RIGHT_FD_READ, inheriting: 0n });
    const counts = { ...wrapped.counts };
    const kind = host.wasi.descriptors.get(opened.fd)?.resource.kind;
    const text = opened.errno === 0 && kind === "file" ? host.readAll(opened.fd) : undefined;
    if (opened.errno === 0) host.close(opened.fd);
    opens.push({ label, errno: opened.errno, text, kind: opened.errno ? undefined : kind, counts });
  };
  try {
    const epoch = new Int32Array(data.connection.epoch);
    const directory = (path: string) => {
      const opened = host.openRaw(3, path, { oflags: 2, base: RIGHTS_ALL });
      if (opened.errno) throw new Error(`open ${path} failed with ${opened.errno}`);
      return opened.fd;
    };
    const sub = data.layout === "volume" ? directory("sub") : undefined;
    const dot = directory(".");
    const epochBefore = Atomics.load(epoch, 0);
    if (sub !== undefined) for (let i = 0; i < 4; i++) open("sub file", sub, "hello.txt");
    if (sub !== undefined) open("sub missing", sub, "missing/child");
    open("dot dev/fd/0", dot, "dev/fd/0");
    open("dot dev/null", dot, "dev/null");
    open("preopen dev/null", 3, "dev/null");
    const epochAfter = Atomics.load(epoch, 0);
    self.postMessage({ epochBefore, epochAfter, opens } satisfies RootIdentityReport);
  } finally {
    host.wasi.descriptors.dispose();
    client.dispose();
  }
};
