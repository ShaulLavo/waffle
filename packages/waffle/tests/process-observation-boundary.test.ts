import { expect, test } from "bun:test";
import { bootstrap, type RuntimeWorkerMessage } from "../browser/worker.ts";
import { admitProcessObservation, captureNativeReturn } from "../proc/observation.ts";
import { outcomeWord, serializeOutcome, claimOutcome, readOutcome } from "../proc/outcome.ts";
import { createFilesystemConnection } from "../fs/protocol.ts";
import { observationModule } from "./fixtures/process-observation-controls.ts";
import { createWorkerProcessTransport, workerProcessState } from "../proc/worker-client.ts";

for (const mode of ["pending", "selected", "terminated"] as const) {
  test(`generic standalone bootstrap rejects a ${mode} observer over another canonical word`, async () => {
    const connection = createFilesystemConnection();
    const canonical = outcomeWord();
    const foreign = outcomeWord();
    const observation = admitProcessObservation(2, foreign);
    if (mode === "selected") claimOutcome(foreign, { kind: "signaled", code: 9 });
    if (mode === "terminated") captureNativeReturn(observation)();
    const messages: RuntimeWorkerMessage[] = [];
    let entered = false;
    try {
      await bootstrap(
        {
          module: observationModule,
          args: [],
          env: {},
          controlGrant: { kind: "unbounded" },
          filesystem: connection.client,
          outcome: serializeOutcome(canonical),
          observation,
        },
        {
          setup({ fs }) {
            fs.preopen = () => 1;
            fs.retain = () => {};
            fs.release = () => {};
          },
          namespaces() {
            return { env: { held() {} } };
          },
          run() {
            entered = true;
            return 0;
          },
        },
        {
          crossOriginIsolated: true,
          postMessage(message) {
            messages.push(message);
          },
        },
      );
      expect(entered).toBe(false);
      expect(messages.some((message) => message.type === "observation-error")).toBe(true);
      expect(readOutcome(canonical)).toBeNull();
      expect(readOutcome(foreign)).toEqual(
        mode === "selected" ? { kind: "signaled", code: 9, status: 137 } : null,
      );
      expect(messages.some((m) => m.type === "exit" || m.type === "default-signal")).toBe(false);
    } finally {
      connection.client.port.close();
      connection.server.port.close();
    }
  });
}

test("generic directory bootstrap does not forward a foreign selected observer", async () => {
  const connection = createFilesystemConnection();
  const transport = createWorkerProcessTransport({ capacity: 1 });
  const canonical = workerProcessState(transport).signals.outcome;
  const foreign = outcomeWord();
  claimOutcome(foreign, { kind: "signaled", code: 9 });
  const observation = admitProcessObservation(2, foreign);
  const messages: RuntimeWorkerMessage[] = [];
  try {
    await bootstrap(
      {
        module: observationModule,
        args: [],
        env: {},
        controlGrant: { kind: "unbounded" },
        filesystem: connection.client,
        runtimeProcess: transport,
        outcome: serializeOutcome(canonical),
        observation,
      },
      {
        run() {
          throw new Error("must not enter");
        },
      },
      {
        crossOriginIsolated: true,
        postMessage(message) {
          messages.push(message);
        },
      },
    );
    expect(messages.some((message) => message.type === "observation-error")).toBe(true);
    expect(messages.some((m) => m.type === "default-signal" || m.type === "exit")).toBe(false);
  } finally {
    connection.client.port.close();
    connection.server.port.close();
  }
});
