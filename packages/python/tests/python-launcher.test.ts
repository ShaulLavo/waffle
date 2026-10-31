import assert from "node:assert/strict";
import { test } from "node:test";
import type { RuntimeProcessContext } from "waffle";
import { pythonLaunchContext } from "../src/launcher.ts";

const environments: Record<string, string>[] = [
  { TOKEN: "kept" },
  { TOKEN: "kept", PWD: "/other" },
];
for (const env of environments) {
  test(`Python establishes cwd with ${"PWD" in env ? "stale" : "absent"} PWD`, () => {
    const request: RuntimeProcessContext["request"] = {
      executable: "/usr/bin/python",
      argv: ["/cross-build/wasm32-wasip1/python.wasm", "script.py", "", "x"],
      cwd: "/home/guest",
      env,
      job: -1,
      fds: [{ child: 7, parent: 9 }],
    };
    const descriptors = { marker: "same descriptor owner" };
    const context = { request, descriptors };
    const launched = pythonLaunchContext(context);
    assert.equal(launched.request.cwd, "/home/guest");
    assert.deepEqual(launched.request.env, { ...env, PWD: "/home/guest" });
    assert.equal(launched.request.argv, request.argv);
    assert.equal(launched.request.fds, request.fds);
    assert.equal(launched.descriptors, descriptors);
    assert.equal(context.request, request);
    assert.equal(context.request.env, env);
  });
}
