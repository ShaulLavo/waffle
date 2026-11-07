import { safeStagingNative } from "../safe-staging-browser.js";
import { checkpointDecodeControl } from "../indexeddb-checkpoint-decode-browser.js";
import { stagingDatabaseName } from "./safe-staging-allocation.js";
import { startPage } from "./page-main.js";

async function gateControl(fixture: "staging" | "decoder", late: boolean): Promise<string> {
  const original = IDBFactory.prototype.open;
  let opens = 0;
  IDBFactory.prototype.open = function (...args: Parameters<typeof original>) {
    opens++;
    return original.apply(this, args);
  };
  const entered = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<void>();
  let current = true;
  const name = stagingDatabaseName(
    crypto.randomUUID(),
    async () => {
      entered.resolve();
      await reply.promise;
    },
    () => current,
  );
  const running =
    fixture === "staging"
      ? safeStagingNative("genesisReopen", name)
      : checkpointDecodeControl.run(name);
  const outcome = running.then(() => "unexpected fulfilment", String);
  try {
    await entered.promise;
    if (opens !== 0) throw new Error("Constructor ran before allocation ACK");
    if (late) {
      current = false;
      reply.resolve();
    } else reply.reject(new Error("allocation rejected control"));
    const error = await outcome;
    const expected = late ? "acknowledgement is no longer current" : "allocation rejected control";
    if (!error.includes(expected) || opens !== 0)
      throw new Error(`Bad allocation gate: ${error}, opens ${opens}`);
    return `${fixture}: ${late ? "late" : "rejected"} ACK prevented open`;
  } finally {
    current = false;
    reply.reject(new Error("control cleanup"));
    await outcome;
    IDBFactory.prototype.open = original;
  }
}
startPage<Record<string, never>>({
  list: () => Promise.resolve({ ids: ["staging-allocation-controls"] }),
  async run() {
    const observations: string[] = [];
    for (const fixture of ["staging", "decoder"] as const) {
      for (const late of [false, true]) observations.push(await gateControl(fixture, late));
    }
    return observations;
  },
  finish: (ledger) => Promise.resolve(ledger.slice()),
});
