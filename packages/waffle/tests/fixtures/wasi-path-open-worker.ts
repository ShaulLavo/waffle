import { RIGHTS_ALL, RIGHT_FD_READ, RIGHT_FD_WRITE } from "../../core/rights.js";
import { FilesystemClient, type FilesystemConnection } from "../../fs/index.js";
import { countingFs, createPathOpenHost } from "./wasi-path-open-host.js";

self.onmessage = ({ data }: MessageEvent<FilesystemConnection>) => {
  const client = new FilesystemClient(data);
  const wrapped = countingFs(client);
  const host = createPathOpenHost(wrapped.fs);
  try {
    const subDir = host.openRaw(3, "work/sub", { oflags: 2, base: RIGHTS_ALL });
    const openedRoot = host.openRaw(3, ".", { oflags: 2, base: RIGHTS_ALL });
    const epochView = new Int32Array(data.epoch);
    const epochBefore = Atomics.load(epochView, 0);

    const opens: { errno: number; text: string; counts: typeof wrapped.counts }[] = [];
    for (let i = 0; i < 4; i++) {
      wrapped.reset();
      const opened = host.openRaw(subDir.fd, "hello.txt", { base: RIGHT_FD_READ });
      const snap = { ...wrapped.counts };
      const text = opened.errno === 0 ? host.readAll(opened.fd) : "";
      if (opened.errno === 0) host.close(opened.fd);
      opens.push({ errno: opened.errno, text, counts: snap });
    }

    wrapped.reset();
    const denied = host.openRaw(subDir.fd, "readonly.txt", { base: RIGHT_FD_WRITE });
    const deniedCounts = { ...wrapped.counts };

    wrapped.reset();
    const devNull = host.openRaw(openedRoot.fd, "dev/null", { base: RIGHT_FD_READ });
    const devNullCounts = { ...wrapped.counts };
    const devNullKind = host.wasi.descriptors.get(devNull.fd)?.resource.kind;
    if (devNull.errno === 0) host.close(devNull.fd);

    host.close(3);
    wrapped.reset();
    const afterCloseRoot = host.openRaw(openedRoot.fd, "dev/fd/0", {
      base: RIGHT_FD_READ,
      inheriting: 0n,
    });
    const afterCloseRootCounts = { ...wrapped.counts };
    if (afterCloseRoot.errno === 0) host.close(afterCloseRoot.fd);

    const epochAfter = Atomics.load(epochView, 0);
    self.postMessage({
      subDirErrno: subDir.errno,
      openedRootErrno: openedRoot.errno,
      epochBefore,
      epochAfter,
      opens,
      deniedErrno: denied.errno,
      deniedCounts,
      devNullErrno: devNull.errno,
      devNullKind,
      devNullCounts,
      afterCloseRootErrno: afterCloseRoot.errno,
      afterCloseRootCounts,
    });
  } finally {
    host.wasi.descriptors.dispose();
    client.dispose();
  }
};
