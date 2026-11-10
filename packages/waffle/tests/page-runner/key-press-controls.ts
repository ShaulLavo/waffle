import { keyPressAdapter } from "./key-press-suite.js";
import { join } from "node:path";
import { runPageSuite } from "waffle/testing/page-runner";
import { PlaywrightDriver } from "waffle/testing/page-runner/playwright";
import {
  keyControls,
  checkKeyEdges,
  checkKeyEffect,
  type KeyEffect,
} from "./key-press-observation.js";
import { installKeyControl } from "./key-press-fixture.js";
import { record } from "./protocol.js";

class OriginalKeyDriver extends PlaywrightDriver {
  constructor(
    engine: "chromium" | "firefox",
    scratch: string,
    private readonly reference: KeyEffect[],
  ) {
    super(engine, scratch);
  }
  override async start(signal: AbortSignal): Promise<void> {
    await super.start(signal);
    await this.navigate("data:text/html,<title>Original keyboard control</title>", signal);
    await this.script(`window.__keyControl=(${installKeyControl.toString()})();`, signal);
    for (const item of keyControls) {
      await this.script(
        `window.__keyControl.setup('primary',${JSON.stringify(item.value)},${item.position},false);`,
        signal,
      );
      // This is the current owned Page's unguarded original action, used only as a reference.
      await super.press(item.key, { signal, dispatch: (send) => send() });
      const snapshot = await this.script("return window.__keyControl.snapshot();", signal);
      checkKeyEdges(snapshot, item.key, "primary", false);
      checkKeyEffect(snapshot, item.key, item.value, item.position, false);
      this.reference.push(parseSnapshot(snapshot));
    }
  }
}
function parseSnapshot(value: unknown): KeyEffect {
  if (
    !record(value) ||
    typeof value.focused !== "string" ||
    typeof value.value !== "string" ||
    typeof value.start !== "number" ||
    typeof value.end !== "number" ||
    typeof value.decoy !== "string" ||
    !Array.isArray(value.events)
  )
    throw new Error("Malformed original key snapshot");
  return { value: value.value, start: value.start, end: value.end };
}
export async function keyPressControl(engine: "chromium" | "firefox", root: string): Promise<void> {
  const reference: KeyEffect[] = [];
  const result = await runPageSuite(
    keyPressAdapter(reference),
    (scratch) => new OriginalKeyDriver(engine, scratch, reference),
    {
      scratchRoot: process.env.STORAGE_SCRATCH_ROOT,
      resultPath: join(root, `key-press-${engine}.json`),
    },
  );
  if (
    result.exit !== 0 ||
    !result.runComplete ||
    Object.values(result.cleanup).some((step) => record(step) && step.status === "unconfirmed")
  )
    throw new Error(`Key control failed: ${JSON.stringify(result)}`);
  console.log(
    JSON.stringify({
      engine,
      reference,
      results: result.results,
      cleanup: result.cleanup,
      runComplete: result.runComplete,
    }),
  );
}
