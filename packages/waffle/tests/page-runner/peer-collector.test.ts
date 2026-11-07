import { expect, test } from "bun:test";
import { Collector } from "./collector.js";

test("peer registration preserves the coordinator and independent ordered streams", () => {
  const collector = new Collector("run", ["case"], ["case"], { listIds: () => ["case"], check() {} });
  const root = collector.expect({ id: "case", role: "case", caseIds: ["case"], execution: "host" }, "root", "http://runner/?token=root", "root");
  collector.receive({ run: "run", doc: "root-doc", seq: 0, kind: "hello", token: "root", group: "case" });
  collector.receive({ run: "run", doc: "root-doc", seq: 1, kind: "case-ready", caseId: "case" });
  collector.beginHost(root, "case");
  const peer = collector.expectPeer(root, "peer", 0, "peer-token", "http://runner/?token=peer-token", "peer-handle");
  collector.receive({ run: "run", doc: "peer-doc", seq: 0, kind: "hello", token: "peer-token", group: "case" });
  collector.receive({ run: "run", doc: "peer-doc", seq: 1, kind: "peer-ready" });
  collector.receive({ run: "run", doc: "root-doc", seq: 2, kind: "error", message: "root" });
  collector.receive({ run: "run", doc: "peer-doc", seq: 2, kind: "error", message: "peer" });
  expect(collector.active).toBe(root);
  expect(peer.messages).toHaveLength(3);
  expect(root.messages).toHaveLength(3);
  expect(collector.failures.map((failure) => failure.detail)).toEqual(["root", "peer"]);
});
