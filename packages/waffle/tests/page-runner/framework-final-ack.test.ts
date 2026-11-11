import { expect, test } from "bun:test";
import { once } from "node:events";
import { createServer, ServerResponse } from "node:http";
import { dropFinalAck } from "./framework-dom-controls.js";

function finish(response: ServerResponse, errors: unknown[]): void {
  try {
    response.end("Original acknowledgement");
  } catch (error) {
    errors.push(error);
    ServerResponse.prototype.end.call(response, "Fixture parse failed", "utf8");
  }
}

function fixture(status: number, errors: unknown[]) {
  return createServer((request, response) => {
    dropFinalAck(request, response);
    response.statusCode = status;
    if (status >= 400) {
      finish(response, errors);
      request.resume();
      return;
    }
    request.on("end", () => finish(response, errors));
    request.resume();
  });
}

async function reply(status: number, body: string) {
  const errors: unknown[] = [];
  const server = fixture(status, errors);
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected an HTTP listener");
    const response = await fetch(`http://127.0.0.1:${address.port}/report`, {
      method: "POST",
      body,
    });
    return { status: response.status, text: await response.text(), errors };
  } finally {
    const stopped = once(server, "close");
    server.closeAllConnections();
    server.close();
    await stopped;
  }
}

test("final acknowledgement fixture preserves early rejection without reading an incomplete body", async () => {
  expect(await reply(409, "")).toEqual({
    status: 409,
    text: "Original acknowledgement",
    errors: [],
  });
});

test("final acknowledgement fixture still drops the accepted retirement acknowledgement", async () => {
  expect(await reply(200, JSON.stringify({ kind: "retire-ready" }))).toEqual({
    status: 503,
    text: "Deliberate final acknowledgement loss",
    errors: [],
  });
});

test("final acknowledgement fixture preserves other accepted reports", async () => {
  expect(await reply(200, JSON.stringify({ kind: "event" }))).toEqual({
    status: 200,
    text: "Original acknowledgement",
    errors: [],
  });
});

test("final acknowledgement fixture rejects malformed successful reports", async () => {
  const result = await reply(200, "not JSON");
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toBeInstanceOf(SyntaxError);
});
