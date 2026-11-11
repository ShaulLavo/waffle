/** Observes every SharedArrayBuffer construction of the real filesystem modules. The observer
 * is installed before any of them is evaluated, so constructors they capture at module load are
 * observed too. That is why the modules are imported dynamically, in a Worker of their own: in
 * the test process another file may already have loaded them with the native constructor. */
export {};

const Native = globalThis.SharedArrayBuffer;
const constructions: { bytes: number; maximum: number | null }[] = [];
let refuse: ((bytes: number, maximum: number | null) => boolean) | undefined;
const observed: typeof SharedArrayBuffer = new Proxy(Native, {
  construct(target, args: [number, { maxByteLength?: number }?], newTarget) {
    const maximum = args[1]?.maxByteLength ?? null;
    if (refuse?.(args[0], maximum)) throw new RangeError("injected construction refusal");
    constructions.push({ bytes: args[0], maximum });
    return Reflect.construct(target, args, newTarget === observed ? target : newTarget);
  },
});
globalThis.SharedArrayBuffer = observed;

const take = () => constructions.splice(0);
const file = (ino: number, size: number) => ({
  kind: "file" as const,
  ino,
  nlink: 1,
  size,
  mtime: 1,
});
const errnoOf = (run: () => unknown): number | null => {
  try {
    run();
    return null;
  } catch (error) {
    return (error as { errno?: number }).errno ?? -1;
  }
};

async function observe() {
  const protocol = await import("../../fs/protocol.js");
  const { SharedFilesystemState } = await import("../../fs/shared.js");
  const { TOTAL_DATA_PAGES, DATA_PAGE_BYTES } = await import("../../fs/storage-geometry.js");
  const { workspacePublication } = await import("../../fs/workspace-protocol.js");
  const { publicationBufferPlan } = await import("../../fs/publication.js");
  const segmentBytes = protocol.SHARED_SEGMENT_BYTES;
  const imported = take();

  // An empty independent identity, then its connection.
  const identity = protocol.createFilesystemIdentity();
  const identityConstructions = take();
  const pair = protocol.connectFilesystemIdentity(identity);
  const connectionConstructions = take();
  pair.client.port.close();
  pair.server.port.close();
  protocol.createFilesystemIdentity(identity);
  const forkConstructions = take();

  const plan = protocol.filesystemOwnerPlan(workspacePublication);
  const arena = publicationBufferPlan(workspacePublication.limits, workspacePublication.observe);

  // The owner at the full default cap: only the last page is free.
  const owner = new SharedFilesystemState(identity.shared, identity.maxBytes);
  owner.owners.fill(1, 0, TOTAL_DATA_PAGES - 1);
  owner.register(0, file(1, DATA_PAGE_BYTES));
  const lastPageConstructions = take();
  const pastCap = errnoOf(() => owner.register(1, file(2, DATA_PAGE_BYTES)));
  const pastCapConstructions = take();

  // A real native refusal of the second new segment of one request.
  const tree = protocol.createFilesystemIdentity(undefined, segmentBytes * 4);
  const state = new SharedFilesystemState(tree.shared, tree.maxBytes);
  state.register(0, file(1, segmentBytes));
  take();
  let attempts = 0;
  refuse = (bytes, maximum) => bytes === segmentBytes && maximum === null && ++attempts === 2;
  const used = state.resources().usedBytes;
  const refused = errnoOf(() => state.register(1, file(2, segmentBytes + DATA_PAGE_BYTES * 2)));
  refuse = undefined;
  const refusedConstructions = take();
  const afterRefusal = {
    usedBytes: state.resources().usedBytes - used,
    built: state.segments.map((buffer, index) => (buffer ? index : -1)).filter((i) => i > 0),
    announced: state.takeNewSegments().map((segment) => segment.index),
    hasFile: state.hasFile(1),
  };
  state.register(1, file(2, segmentBytes + DATA_PAGE_BYTES * 2));
  const retried = {
    constructions: take(),
    announced: state.takeNewSegments().map((segment) => segment.index),
  };

  return {
    imported,
    maxBytes: identity.maxBytes,
    segments: identity.segments.length,
    identityConstructions,
    connectionConstructions,
    forkConstructions,
    plan,
    arenaAllocations: arena.allocations,
    lastPageConstructions,
    lastSegment: owner.segments.map((buffer, index) => (buffer ? index : -1)).filter((i) => i > 0),
    pastCap,
    pastCapConstructions,
    refused,
    refusedConstructions,
    afterRefusal,
    retried,
  };
}

self.onmessage = () => {
  void observe().then(
    (value) => self.postMessage({ value }),
    (error: unknown) => self.postMessage({ error: String(error), stack: (error as Error)?.stack }),
  );
};
