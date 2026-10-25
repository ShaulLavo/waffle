import { expect, test } from "bun:test";
import { body, decode, handle, head, pair, response } from "./loopback-fetch-fixture.js";

test("shared Worker follows a relative loopback redirect before publishing the head", async () => {
  const { server, client, listener, url } = await pair();
  const first = server.call({ op: "respond", listener, bytes: response(302, "Location: ./final?ok=1\r\n") });
  const id = await handle(client, { op: "fetch", url: `${url}/dir/start` });
  await first;
  const final = server.call({ op: "respond", listener, bytes: response(200, "", "done") });
  expect(await head(client, id)).toMatchObject({ status: 200, url: `${url}/dir/final?ok=1`, redirected: true });
  expect(decode(await body(client, id))).toBe("done");
  expect(await final).toMatchObject({ request: expect.stringContaining("GET /dir/final?ok=1 HTTP/1.1") });
});
