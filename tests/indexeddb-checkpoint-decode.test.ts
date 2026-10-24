import { expect, test } from "bun:test";
import { snapshotPublicationCheckpoint } from "../fs/publication.js";
import { checkpointDecodeControl } from "./indexeddb-checkpoint-decode-browser.js";

function validationTests(): void {
  test("small selected checkpoint owns a valid bounded change and reserved frontier", () => {
    const fixture = checkpointDecodeControl.fixture();
    const copied = snapshotPublicationCheckpoint(fixture);
    expect(copied).toEqual(fixture);
    expect(copied.changes[0]).not.toBe(fixture.changes[0]);
    expect(copied.sessionSerial).toBe(65536);
    expect(copied.contentVersions).toEqual([{ ino: 2, version: 1 }]);
    expect(copied.changes).toHaveLength(1);
    expect(copied.changes[0]!.length).toBeLessThanOrEqual(1024);
  });
  test("small selected checkpoint rejects more than one change", () => {
    const fixture = checkpointDecodeControl.fixture();
    expect(() =>
      snapshotPublicationCheckpoint({
        ...fixture,
        changes: fixture.changes.concat(fixture.changes),
      }),
    ).toThrow();
  });
  test("small selected checkpoint rejects a change above its effect byte limit", () => {
    const fixture = checkpointDecodeControl.fixture();
    expect(() =>
      snapshotPublicationCheckpoint({ ...fixture, changes: [new Uint8Array(1025)] }),
    ).toThrow();
  });
}
validationTests();
