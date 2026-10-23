import { expect, test } from "bun:test";
import { FilesystemError, PAGE } from "../fs/protocol";
import type { NamespaceCut, ReadFailure } from "../fs/workspace-types";
import { residentReadFixture } from "./fixtures/workspace-read";

type Fixture = Awaited<ReturnType<typeof residentReadFixture>>;

async function alternateFailures(
  value: Fixture,
  stat: () => Promise<unknown>,
  expected: ReadFailure,
) {
  for (let index = 0; index < 65; index++) {
    expect(await stat()).toEqual(expected);
    expect((await value.workspace.read("/file", { offset: 0, length: 1 })).kind).toBe("ok");
  }
  expect(value.service.resources().readerTickets).toBe(0);
  expect(value.service.resources().readerOperations).toBe(0);
  expect((await value.workspace.read("/file", { offset: 0, length: 1 })).kind).toBe("ok");
  expect((await value.workspace.stat("/file")).kind).toBe("ok");
  const pinned = await value.workspace.pin("/file");
  expect(pinned.kind).toBe("ok");
  if (pinned.kind === "ok") await pinned.value.close();
  expect(value.client.completions.size).toBe(0);
}

function abortedStat(value: Fixture, selected: NamespaceCut) {
  const controller = new AbortController();
  const cut = {
    ...selected,
    get watermark() {
      controller.abort();
      return selected.watermark;
    },
  };
  return value.workspace.stat("/file", cut, controller.signal);
}

async function refusedStat(value: Fixture) {
  const submit = value.client.submit.bind(value.client);
  value.client.submit = (operation, ...args) => {
    if (operation === "publicationReadStat") throw new FilesystemError(6);
    return submit(operation, ...args);
  };
  try {
    return await value.workspace.stat("/file");
  } finally {
    value.client.submit = submit;
  }
}

test("invalid stat targets cannot fragment reader serial retirement", async () => {
  const value = await residentReadFixture(PAGE);
  try {
    await alternateFailures(value, () => value.workspace.stat("relative"), {
      kind: "invalid",
      field: "target",
    });
  } finally {
    await value.close();
  }
});

test("invalid stat cuts cannot fragment reader serial retirement", async () => {
  const value = await residentReadFixture(PAGE);
  try {
    const before = await value.workspace.stat("/file");
    await value.client.asyncCall("writeFile", ["/file"], new Uint8Array([65]));
    const after = await value.workspace.stat("/file");
    if (before.kind !== "ok" || after.kind !== "ok") throw new Error("stat fixture failed");
    const cut = { ...after.value.cut, watermark: before.value.cut.watermark };
    await alternateFailures(value, () => value.workspace.stat("/file", cut), {
      kind: "invalid",
      field: "cut",
    });
  } finally {
    await value.close();
  }
});

test("stat abort before submission still retires its reserved serial", async () => {
  const value = await residentReadFixture(PAGE);
  try {
    const selected = await value.workspace.stat("/file");
    if (selected.kind !== "ok") throw new Error(selected.kind);
    await alternateFailures(value, () => abortedStat(value, selected.value.cut), {
      kind: "cancelled",
    });
  } finally {
    await value.close();
  }
});

test("stat submission refusal still retires its reserved serial", async () => {
  const value = await residentReadFixture(PAGE);
  try {
    await alternateFailures(value, () => refusedStat(value), {
      kind: "pressure",
      resource: "operations",
    });
  } finally {
    await value.close();
  }
});

test("sparse untrusted serial closes retain the bounded fail-closed ledger", async () => {
  const value = await residentReadFixture(PAGE);
  const grant = value.client.connection.publication!.observer;
  try {
    for (let id = 2; id <= 130; id += 2)
      await value.client.asyncCall("publicationReadClose", [grant, id]);
    expect(value.service.resources().readerTickets).toBe(0);
    expect(
      await value.client.asyncCall("publicationReadOpen", [
        grant,
        1,
        "/file",
        { offset: 0, length: 1 },
      ]),
    ).toEqual({ kind: "unavailable" });
  } finally {
    await value.close();
  }
});
