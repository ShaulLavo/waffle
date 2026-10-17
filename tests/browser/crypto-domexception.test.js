import {test, expect} from "bun:test";
import {readFileSync} from "node:fs";
import {webcrypto} from "node:crypto";
test("host crypto errors retain the DOMException brand", async () => {
  const streams = (0, eval)(readFileSync(new URL("../../crates/bunwasm-runtime/src/js/streams.js", import.meta.url), "utf8"));
  const internal = {require(name) { expect(name).toBe("streams"); return streams({native:{engine:"host"}}); }, native:{DOMException, timeOrigin:()=>0, platformInfo:{version:"test",arch:"wasm"}}};
  const factory = (0, eval)(readFileSync(new URL("../../crates/bunwasm-runtime/src/js/web.js", import.meta.url),"utf8"));
  factory(internal);
  let error;
  try { await webcrypto.subtle.importKey("raw",new Uint8Array(1),"AES-GCM",false,["encrypt"]); }
  catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(DOMException);
  expect(error).toBeInstanceOf(internal.DOMException);
});
