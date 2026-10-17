import { expect, test } from "bun:test";
import { SubprocessHost, type ChildTransport } from "../src/subprocess.ts";
import { launchNodeExecutable } from "../scripts/node-spawn.ts";

for (const executable of ["bun", "/bun", "/usr/local/bin/bun", "node", "/node", "/usr/local/bin/node"]) test(`Node host registry explicitly resolves ${executable}`, () => {
  let launched = 0;
  const host = new SubprocessHost({ output() {}, launch(meta, transport) {
    return launchNodeExecutable(meta, transport, () => { launched++; return { terminate() {} }; });
  } });
  try {
    const pid = host.spawn(JSON.stringify({ argv: [executable, "argument"] }));
    expect(pid).toBeGreaterThan(1);
    expect(launched).toBe(1);
    expect(host.wait(pid)).toBe(-2);
  } finally { host.dispose(); }
});

test("Node host does not silently execute Bun for a missing registry entry", () => {
  let launched = 0;
  let child: ChildTransport | undefined;
  const host = new SubprocessHost({ output() {}, launch(meta, transport) {
    child = transport;
    return launchNodeExecutable(meta, transport, () => { launched++; return { terminate() {} }; });
  } });
  try {
    const pid = host.spawn(JSON.stringify({ executable: "missing", argv: ["missing"] }));
    expect(pid).toBeGreaterThan(1);
    expect(launched).toBe(0);
    expect(host.wait(pid)).toBe(127);
    expect(child?.pid).toBe(pid);
    expect(new TextDecoder().decode(host.read(host.pipe(pid, 2)) as Uint8Array)).toContain("missing");
  } finally { host.dispose(); }
});
