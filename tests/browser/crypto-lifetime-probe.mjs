import {startEngineHost} from "../src/engine-host.js";
globalThis.__rejectNativeCrypto = process.env.NATIVE_CRYPTO_REJECT === "1";
const memory = new WebAssembly.Memory({initial:1, maximum:2});
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
function encode(value) {
  if (value === undefined) return Buffer.from([0]);
  if (typeof value === "string") {
    const bytes = Buffer.from(value);
    return Buffer.concat([Buffer.from([5]), u32(bytes.length), bytes]);
  }
  if (Array.isArray(value)) return Buffer.concat([Buffer.from([7]), u32(value.length)].concat(value.map(encode)));
  const entries = Object.entries(value);
  const fields = entries.flatMap(([key, item]) => [u32(Buffer.byteLength(key)), Buffer.from(key), encode(item)]);
  return Buffer.concat([Buffer.from([8]), u32(entries.length)].concat(fields));
}
const put = value => new Uint8Array(memory.buffer).set(encode(value));
const source = `(function(native) {
  return {
    crypto: {makeKey:()=>Object.create({}),encode:()=>"",isKey:()=>false},
    runMain() {
      if (globalThis.__rejectNativeCrypto) {
        native.subtleCrypto.generateKey({name:"HMAC", length:128}, true, ["sign"]);
        return Promise.resolve();
      }
      native.subtleCrypto.importKey("raw", new Uint8Array([1,2,3]), "PBKDF2", false, ["deriveBits"])
        .then(key => native.subtleCrypto.deriveBits({name:"PBKDF2", hash:"SHA-256", salt:new Uint8Array([4,5]), iterations:5000000}, key, 128))
        .then(() => { globalThis.__cryptoSettled = true; });
      return Promise.resolve();
    },
    runTimers: () => -1, ioPending: () => 0, emitBeforeExit: () => false,
    beforeExit: () => 0, handleRejection: error => { console.error("native rejection", error.name); return false; }, handleUncaught: error => { throw error; }
  };
})`;
await startEngineHost({instance:{exports:{
  memory, bunwasm_alloc:() => 32768, bunwasm_result_ptr:() => 0,
  bunwasm_describe() {put({natives:["polyfillSource", "flushOutput", "writeStderr", "closeAllDirs"], constants:{hostCaps:{}}, entry:{kind:"run", main:"/main.js"}});},
  bunwasm_call(index) {put(index === 0 ? source : undefined); return 0;},
}}, onExit(code) {
  if (globalThis.__rejectNativeCrypto) process.exit(code);
  if (code !== 0 || globalThis.__cryptoSettled !== true) {
    console.error("host exited before native SubtleCrypto settled");
    process.exit(1);
  }
  console.log("native SubtleCrypto keeps the host alive");
  process.exit(0);
}});
