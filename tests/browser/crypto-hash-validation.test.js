import {test, expect} from "bun:test";
import {readFileSync} from "node:fs";
import {runInNewContext} from "node:vm";
function provider() {
  const crypto = {};
  let allocations = 0;
  const source = readFileSync(process.env.CRYPTO_VALIDATION_SOURCE || new URL("../../crates/bunwasm-runtime/src/js/crypto.js", import.meta.url),"utf8");
  const factory = runInNewContext(source,{crypto,DOMException,ArrayBuffer,Uint8Array});
  const internal = {native:{
    randomBytes:length=>{allocations++;return new Uint8Array(length);},
    base64Encode:bytes=>Buffer.from(bytes).toString("base64url"),
    base64Decode:value=>new Uint8Array(Buffer.from(value,"base64url")),
  },toUint8:value=>value};
  factory(internal)(()=>{});
  return {subtle:crypto.subtle, allocations:()=>allocations};
}
test("HMAC requires hash before allocating key material", async () => {
  const {subtle,allocations} = provider();
  for (const length of [undefined,128])
    await expect(subtle.generateKey({name:"HMAC",length},true,["sign"])).rejects.toHaveProperty("name","TypeError");
  expect(allocations()).toBe(0);
});
test("HMAC derivation validates hash before base-key access", async () => {
  const {subtle} = provider();
  const key = await subtle.importKey("raw",new Uint8Array([1]),"PBKDF2",false,["deriveBits"]);
  await expect(subtle.deriveKey({name:"PBKDF2",hash:"SHA-256",salt:new Uint8Array([1]),iterations:1},key,{name:"HMAC",length:128},true,["sign"]))
    .rejects.toHaveProperty("name","TypeError");
});
