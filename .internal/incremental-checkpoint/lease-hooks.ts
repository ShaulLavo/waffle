export const checkpointRun = `
async function checkpointRun(io: WorkloadIO, facade: SharedFilesystem, lane: Lane, leased: boolean) {
  const { path, size, editSize, seedIdentity, editIdentity } = CHECKPOINT;
  const host = new HostIO(facade);
  const before = facade.client.shared.resources();
  if ((await io.stat(path)).size !== size) throw new Error("Unexpected seed size");
  const warmStart = performance.now();
  await host.warm(path, size);
  const hydrationMs = performance.now() - warmStart;
  verify(await host.read(path, checkpointOffset, editSize), seedIdentity, editSize, checkpointOffset);
  const ready = facade.client.shared.resources();
  if (ready.usedBytes !== size) throw new Error("Warm-up did not hydrate the exact file size");
  await facade.flush();
  const pin = leased ? await facade.workspace?.pin(path) : undefined;
  if (leased && pin?.kind !== "ok") throw new Error("Could not retain the resident version: " + pin?.kind);
  const lease = pin?.kind === "ok" ? pin.value : undefined;
  const pinnedBytes = facade.client.shared.readerPinBytes();
  const joined = leased ? new FilesystemClient(facade.fork()) : undefined;
  const joinedGuest = joined ? new GuestIO(joined, guest) : undefined;
  const shared = joined?.shared ?? facade.client.shared;
  const directWrite = shared.directWrite;
  let directWriteBytes = 0;
  try {
    shared.directWrite = (...args) => {
      const result = directWrite.apply(shared, args);
      directWriteBytes += result ?? 0;
      return result;
    };
    const editStart = performance.now();
    await (joinedGuest ?? io).write(path, content(editIdentity, editSize, checkpointOffset), checkpointOffset);
    const editMs = performance.now() - editStart;
    if (lane === "guest" && !leased && directWriteBytes !== editSize)
      throw new Error("The matched guest did not write directly");
    const beforeFlush = performance.now();
    await facade.flush();
    const checkpointFlushMs = performance.now() - beforeFlush;
    const after = facade.client.shared.resources();
    const leaseSideEffects = lease ? await verifyCheckpointLease(facade, lease, ready, after, pinnedBytes) : undefined;
    return {
      metrics: { hydrationMs, editMs, checkpointFlushMs },
      latencies: { barrier: [checkpointFlushMs] },
      acknowledgements: [],
      observations: { checkpointOffset, directWriteBytes, before, ready, after, leaseSideEffects },
    };
  } finally {
    shared.directWrite = directWrite;
    joinedGuest?.dispose();
    joined?.dispose();
    await lease?.close();
  }
}

async function verifyCheckpointLease(
  facade: SharedFilesystem,
  lease: import("../fs/workspace-types.js").VersionLease,
  ready: ReturnType<SharedFilesystem["client"]["shared"]["resources"]>,
  after: ReturnType<SharedFilesystem["client"]["shared"]["resources"]>,
  pinnedBytes: number,
) {
  const { path, editSize, seedIdentity, editIdentity, size } = CHECKPOINT;
  const range = { offset: checkpointOffset, length: editSize };
  const old = await lease.read(range);
  const current = await facade.workspace?.read(path, range);
  if (old.kind !== "ok" || current?.kind !== "ok") throw new Error("Failed to read both versions");
  verify(old.value.bytes, seedIdentity, editSize, checkpointOffset);
  verify(current.value.bytes, editIdentity, editSize, checkpointOffset);
  if (old.value.stat.id !== current.value.stat.id || old.value.stat.version === current.value.stat.version)
    throw new Error("Wrong file identity or version after copy on write");
  const cowBytes = after.usedBytes - ready.usedBytes;
  if (pinnedBytes !== size || cowBytes !== 4096) throw new Error("The joined edit must copy exactly one retained page");
  await lease.close();
  const retired = facade.client.shared.resources();
  if (retired.usedBytes !== ready.usedBytes || facade.client.shared.readerPinBytes() !== 0)
    throw new Error("Lease release did not retire the old page");
  return {
    joined: true, pinnedBytes, cowBytes, poolGrowth: after.poolBytes - ready.poolBytes,
    usedBytesAfterRelease: retired.usedBytes, sameFileId: true, verifiedBothVersions: true,
  };
}
`;
