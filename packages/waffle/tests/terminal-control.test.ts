import { expect, test } from "bun:test";
import {
  claimTerminalAuthority,
  createTerminalInput,
  createTerminalInputPolicy,
  createTerminalSession,
  attachTerminal,
  terminalControls,
  TERMINAL_SESSION_LIMITS,
  type TerminalResult,
} from "../browser/runtime-terminals.js";
import { createWorkerProcessTransport } from "../proc/worker-client.js";

function must<T>(result: TerminalResult<T>): T {
  if (result.kind === "error") throw Error(result.code);
  return result.value;
}
function fixture() {
  const root = createWorkerProcessTransport();
  const input = createTerminalInput();
  const display = createTerminalSession({ controller: root, geometry: { columns: 80, rows: 24 } });
  const policy = createTerminalInputPolicy({ input });
  const authority = must(
    claimTerminalAuthority({ identity: display.identity, process: root, checkActive() {}, policy }),
  );
  return { root, input, display, policy, authority };
}

test("control publishes one synchronous turn and permits exact-session root aliases", async () => {
  const f = fixture();
  let calls = 0,
    published = false;
  try {
    const result = await f.authority.control((turn) => {
      calls++;
      const group = must(f.authority.createGroup({ initialMode: "raw" }));
      must(f.authority.admitExisting({ group, pid: f.root.pid }));
      must(f.authority.acquire({ group, expected: null }));
      const attachment = attachTerminal({
        context: f.display.inherit(),
        process: f.root,
        checkActive() {},
        policy: f.policy,
      });
      const snapshot = terminalControls(attachment.resolve(0))!.snapshot();
      expect(snapshot.kind).toBe("ok");
      attachment.dispose();
      turn.publish(() => {
        published = true;
      });
      expect(published).toBe(false);
      return { kind: "ok", value: group };
    });
    expect(result.kind).toBe("ok");
    expect(calls).toBe(1);
    expect(published).toBe(true);
    expect(f.display.snapshot().kind).toBe("ok");
  } finally {
    f.display.close("disposed");
    f.input.close();
  }
});

test("real quota failure rolls back only created allocations and preserves selected reused group", async () => {
  const f = fixture();
  try {
    const editor = must(f.authority.createGroup({ initialMode: "raw" }));
    must(f.authority.admitExisting({ group: editor, pid: f.root.pid }));
    const lease = must(f.authority.acquire({ group: editor, expected: null }));
    const selection = must(f.display.snapshot()).selection;
    const result = await f.authority.control(() => {
      for (let i = 1; i < TERMINAL_SESSION_LIMITS.groups; i++)
        must(f.authority.createGroup({ initialMode: "raw" }));
      return f.authority.createGroup({ initialMode: "raw" });
    });
    expect(result).toMatchObject({ kind: "error", code: "CAPACITY" });
    expect(must(f.display.snapshot()).selection).toBe(selection);
    expect(f.authority.release({ lease, restore: null }).kind).toBe("ok");
    for (let i = 1; i < TERMINAL_SESSION_LIMITS.groups; i++)
      expect(f.authority.createGroup({ initialMode: "raw" }).kind).toBe("ok");
  } finally {
    f.display.close("disposed");
    f.input.close();
  }
});

test("cancel at a granted stage discards publication and permits later control", async () => {
  const f = fixture(),
    cancel = new AbortController();
  let published = false;
  try {
    const result = await f.authority.control(
      (turn) => {
        must(f.authority.createGroup({ initialMode: "raw" }));
        turn.publish(() => {
          published = true;
        });
        cancel.abort();
        return { kind: "ok", value: undefined };
      },
      { signal: cancel.signal },
    );
    expect(result).toMatchObject({ kind: "error", code: "CANCELED" });
    expect(published).toBe(false);
    expect(
      (await f.authority.control(() => f.authority.createGroup({ initialMode: "raw" }))).kind,
    ).toBe("ok");
  } finally {
    f.display.close("disposed");
    f.input.close();
  }
});
