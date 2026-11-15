import { expect, test } from "bun:test";
import { admissionControl, releaseSection } from "./fixtures/thread-admission-control.js";
import { awaitObservationBarrier } from "./fixtures/process-observation-controls.js";
import { captureProcessObserver } from "../proc/observation.js";
import { ProcessError, ProcessErrno } from "../proc/types.js";
import { readOutcome } from "../proc/outcome.js";

test("directory denial precedes Worker acquisition while an owned child retirement is incomplete", async () => {
  const f = await admissionControl(4);
  try {
    const owner = await f.spawn();
    const sibling = await f.spawn();
    await Promise.all([f.ready(owner), f.ready(sibling)]);
    const transport = f.broker.transportFor(owner.pid)!;
    const child = await f.spawn(f.client(transport), {
      owned: true,
      adapterHeld: true,
      nativeHeld: true,
    });
    await f.ready(child);
    f.supervisor.kill(owner.pid, 9);
    await awaitObservationBarrier(() => f.phase(child, "fs-entered"));
    const attempts = f.attempts();
    const jobDenied = await f.spawn().catch((error: unknown) => error);
    expect(jobDenied).toBeInstanceOf(ProcessError);
    if (!(jobDenied instanceof ProcessError)) throw new Error("missing job refusal");
    expect(jobDenied.errno).toBe(ProcessErrno.AGAIN);
    expect(jobDenied.message).toBe("job directory is full");
    const denied = await f
      .spawn(f.parent, { joinJob: f.parent.job })
      .catch((error: unknown) => error);
    expect(denied).toBeInstanceOf(ProcessError);
    if (!(denied instanceof ProcessError)) throw new Error("missing directory refusal");
    expect(denied.errno).toBe(ProcessErrno.AGAIN);
    expect(denied.message).toBe("process directory is full");
    expect(f.attempts()).toBe(attempts);
    expect(readOutcome(f.supervisor.get(sibling.pid)!.outcome)).toBeNull();
    expect(f.supervisor.get(owner.pid)?.result).toBeNull();
    console.info(JSON.stringify(f.scalar("directory-denied-with-old-retirement-held")));
    releaseSection(owner);
    releaseSection(child);
    await awaitObservationBarrier(() => f.phase(child, "fs-returned"));
    expect(f.phase(child, "native-invoked")).toBe(false);
    child.adapter.resolve();
    await awaitObservationBarrier(() => f.phase(child, "native-invoked"));
    expect(f.supervisor.get(owner.pid)?.result).toBeNull();
    child.native.resolve();
    await f.supervisor.waitForExit(f.parent.pid, owner.pid);
    const replacement = await f.spawn();
    await f.ready(replacement);
    expect(replacement.pid).not.toBe(child.pid);
    f.assertFresh();
    expect(f.errors).toEqual([]);
    console.info(JSON.stringify(f.scalar("fresh-acquisition-after-retirement")));
  } finally {
    await f.dispose();
  }
}, 30000);

test("native constructor refusal keeps raw identity and cause during old parent retirement", async () => {
  const f = await admissionControl();
  try {
    const owner = await f.spawn();
    const sibling = await f.spawn();
    await Promise.all([f.ready(owner), f.ready(sibling)]);
    const child = await f.spawn(f.client(f.broker.transportFor(owner.pid)!), {
      owned: true,
      nativeHeld: true,
    });
    await f.ready(child);
    f.supervisor.kill(owner.pid, 9);
    releaseSection(owner);
    releaseSection(child);
    await awaitObservationBarrier(() => f.phase(child, "native-invoked"));
    const cause = new Error("injected platform cause");
    const failure = new Error("injected Worker constructor refusal", { cause });
    f.inject(failure);
    const failed = await f.spawn();
    await failed.starting;
    await awaitObservationBarrier(() => f.errors.includes(failure));
    expect(f.errors[0]).toBe(failure);
    expect(failure.cause).toBe(cause);
    expect(failed.serial).toBe(0);
    expect(f.phase(child, "native-stop-fulfilled")).toBe(false);
    expect(f.supervisor.get(owner.pid)?.result).toBeNull();
    const replacement = await f.spawn();
    await f.ready(replacement);
    expect(readOutcome(f.supervisor.get(sibling.pid)!.outcome)).toBeNull();
    f.assertFresh();
    console.info(
      JSON.stringify({
        ...f.scalar("constructor-refusal-during-native-stop"),
        rawIdentity: f.errors[0] === failure,
        rawCause: failure.cause === cause,
      }),
    );
    child.native.resolve();
    await f.supervisor.waitForExit(f.parent.pid, owner.pid);
  } finally {
    await f.dispose();
  }
}, 30000);

test("accepted late handle and real child FS fence are joined without blocking a sibling acquisition", async () => {
  const f = await admissionControl();
  try {
    const owner = await f.spawn();
    await f.ready(owner);
    const child = await f.spawn(f.client(f.broker.transportFor(owner.pid)!), {
      owned: true,
      lateHandle: true,
      nativeHeld: true,
    });
    await f.ready(child);
    const observer = captureProcessObserver(f.broker.transportFor(child.pid)!);
    f.supervisor.kill(owner.pid, 9);
    releaseSection(owner);
    releaseSection(child);
    await awaitObservationBarrier(() => f.phase(child, "fs-returned"));
    expect(observer.read().kind).toBe("selected");
    await awaitObservationBarrier(() => f.phase(child, "native-invoked"));
    expect(f.phase(child, "adapter-returned")).toBe(false);
    const sibling = await f.spawn();
    await f.ready(sibling);
    expect(f.supervisor.get(owner.pid)?.result).toBeNull();
    child.handle.resolve();
    await child.starting;
    await awaitObservationBarrier(() => f.phase(child, "native-invoked"));
    expect(observer.read().kind).toBe("selected");
    expect(f.supervisor.get(owner.pid)?.result).toBeNull();
    console.info(JSON.stringify(f.scalar("accepted-late-handle-with-native-return-held")));
    child.native.resolve();
    await awaitObservationBarrier(() => f.phase(child, "native-stop-fulfilled"));
    console.info(
      JSON.stringify({
        ...f.scalar("late-native-returned"),
        ownerResult: f.supervisor.get(owner.pid)?.result ?? null,
        childResult: f.supervisor.get(child.pid)?.result ?? null,
        observed: observer.read().kind,
      }),
    );
    await f.supervisor.waitForExit(f.parent.pid, owner.pid);
    expect(f.phase(child, "accepted-handle-fulfilled")).toBe(true);
    expect(observer.read()).toEqual({ kind: "terminated" });
    expect(readOutcome(f.supervisor.get(sibling.pid)!.outcome)).toBeNull();
    f.assertFresh();
    expect(f.errors).toEqual([]);
  } finally {
    await f.dispose();
  }
}, 30000);
