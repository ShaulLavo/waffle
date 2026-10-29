import { SharedFilesystem } from "../browser/shared-fs.js";
import { createRuntime, type Runtime } from "../runtime.js";
import { FilesystemClient } from "../fs/client.js";
import { CAPABILITY_HEADER, CAPABILITY_LENGTH, CAPABILITY_WORDS } from "../fs/protocol.js";
import { requestMemoryRetired } from "../fs/request-memory.js";
import {
  SocketAdmissionRelay,
  type SocketAdmissionObservation,
} from "./fixtures/socket-admission-relay.js";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function bounded<T>(work: Promise<T>, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Socket attachment ${phase} did not settle`)),
          10000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function filesystem() {
  return new SharedFilesystem({
    mode: "memory",
    workspace: true,
    workerURL: new URL("/fs-worker.js", location.href),
  });
}
async function plainAttachment(): Promise<void> {
  const page = filesystem();
  const guest = new FilesystemClient(page.connect(page.createIdentity()));
  let scope: Awaited<ReturnType<SharedFilesystem["attachSocketScope"]>> | undefined;
  let directory: Awaited<ReturnType<SharedFilesystem["directoryHandle"]>> | undefined;
  try {
    directory = await page.directoryHandle("/");
    await guest.asyncCall("preopen", ["/"]);
    scope = await bounded(
      page.attachSocketScope(guest.connection, directory.handle),
      "success reply",
    );
    const error = await bounded(
      page.attachSocketScope(guest.connection, 0x7fffffff).catch((error: unknown) => error),
      "error reply",
    );
    check(
      error && typeof error === "object" && "errno" in error && error.errno === 76,
      "Owner error reply lost",
    );
    const node = await scope.client.asyncCall("bindSocketPath", [scope.root, "/browser.sock", 1]);
    check(node.binding?.ino > 0, "Socket bind failed after attachment");
    check(
      (await scope.client.asyncCall("unbindSocket", [node.binding, node.name, 1, true])) === 0,
      "Socket cleanup failed",
    );
  } finally {
    directory?.release();
    guest.dispose();
    if (scope) {
      await page.quiesce(scope.client.connection);
      scope.client.dispose();
    }
    await bounded(page.dispose(), "filesystem disposal");
  }
}
function rootReferences(observed: SocketAdmissionObservation): number {
  const entries = new Int32Array(observed.capabilities, 0, CAPABILITY_LENGTH);
  for (let at = CAPABILITY_HEADER; at < entries.length; at += CAPABILITY_WORDS) {
    if (entries[at] === observed.root) return entries[at + 1]!;
  }
  return -1;
}
function runtimeFilesystemOwner(): {
  runtime: Runtime;
  owner(): SharedFilesystem;
  restore(): void;
} {
  const original = SharedFilesystem.prototype.directoryHandle;
  let captured: SharedFilesystem | undefined;
  const capture = (owner: SharedFilesystem) => {
    captured = owner;
  };
  SharedFilesystem.prototype.directoryHandle = function (path) {
    capture(this);
    return original.call(this, path);
  };
  const runtime = createRuntime({
    filesystem: {
      mode: "memory",
      workspace: true,
      workerURL: new URL("/fs-worker.js", location.href),
    },
  });
  return {
    runtime,
    owner() {
      check(captured, "Runtime owner was not observed");
      return captured;
    },
    restore() {
      SharedFilesystem.prototype.directoryHandle = original;
    },
  };
}
async function delayedAttachment(forwardLate: boolean): Promise<void> {
  const relay = new SocketAdmissionRelay();
  relay.install();
  const held = runtimeFilesystemOwner();
  let guest: FilesystemClient | undefined;
  let successor: Runtime | undefined;
  try {
    const lease = await held.runtime.filesystem.directoryHandle("/");
    guest = new FilesystemClient(
      held.runtime.filesystem.connect(held.runtime.filesystem.createIdentity()),
    );
    await guest.asyncCall("preopen", ["/"]);
    const attachment = held
      .owner()
      .attachSocketScope(guest.connection, lease.handle)
      .then(
        () => "revived",
        () => "cancelled",
      );
    const observed = await bounded(relay.admitted, "admitted relay");
    check(
      rootReferences(observed) > 0 && !requestMemoryRetired(observed.requests),
      "Relay did not hold a live admitted scope",
    );
    lease.release();
    guest.dispose();
    guest = undefined;
    await bounded(held.runtime.dispose(), "runtime disposal with held reply");
    check(
      (await bounded(attachment, "cancelled attachment")) === "cancelled",
      "Late scope revived",
    );
    check(
      rootReferences(observed) < 0 && requestMemoryRetired(observed.requests),
      "Unreceived admitted scope retained root pins or transport",
    );
    check(
      Atomics.load(new Int32Array(observed.ownerStates), observed.owner) === 2,
      "Unreceived scope identity was not reaped",
    );
    if (forwardLate) relay.forward();
    successor = createRuntime({
      filesystem: {
        mode: "memory",
        workspace: true,
        workerURL: new URL("/fs-worker.js", location.href),
      },
    });
    await successor.filesystem.listFiles("/");
    check(
      rootReferences(observed) < 0 && requestMemoryRetired(observed.requests),
      "Late reply revived retired scope",
    );
    check((await attachment) === "cancelled", "Late reply changed the terminal attachment result");
  } finally {
    guest?.dispose();
    await successor?.dispose();
    await held.runtime.dispose();
    held.restore();
    relay.close();
  }
}
/** @browserEntry Real owner-control attachment and admitted-but-unreceived shutdown cases. */
export async function socketAttachmentCases(): Promise<string[]> {
  await plainAttachment();
  await delayedAttachment(false);
  await delayedAttachment(true);
  return [
    "success/error owner replies survive sender handoff",
    "unreceived admitted scope retires root and transport on runtime shutdown",
    "late forwarded reply cannot revive scope or page guard",
  ];
}
