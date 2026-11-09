import { FilesystemClient, type FilesystemConnection } from "../../fs";

// Deliberately never yield during the operation sequence. A segment the owner builds after this
// guest started cannot be delivered here: a port message needs an event-loop turn. Every byte in
// such a segment has to come through the request arena, which was attached before the guest ran.
let turns = 0;
self.onmessage = ({ data }: MessageEvent<{ connection: FilesystemConnection }>) => {
  self.onmessage = () => {
    turns++;
  };
  setTimeout(() => turns++, 0);
  const fs = new FilesystemClient(data.connection);
  try {
    const root = fs.preopen("/");
    const path = fs.resolve(root, "extra");
    if (typeof path === "number" || path.node === undefined) throw new Error("missing extra file");
    fs.retain(path.node);
    const attachedBefore = fs.shared.segments.length;
    const operations: string[] = [];
    const submit = fs.submit.bind(fs);
    fs.submit = (...args) => {
      operations.push(args[0]);
      return submit(...args);
    };
    const written = fs.write(path.node, [new Uint8Array([65, 66])], 0);
    const appended = fs.append(path.node, [new Uint8Array([67, 68])]);
    const snapshots: number[][] = [];
    for (let i = 0; i < 4; i++) {
      const bytes = new Uint8Array(4);
      if (fs.read(path.node, [bytes], 0) !== 4) throw new Error("short read");
      snapshots.push(Array.from(bytes));
    }
    fs.release(path.node);
    self.postMessage({
      written,
      appended,
      snapshots,
      operations,
      turns,
      attachedBefore,
      attachedAfter: fs.shared.segments.length,
    });
  } finally {
    fs.dispose();
  }
};
