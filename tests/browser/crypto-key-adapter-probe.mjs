import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {webcrypto, randomBytes, timingSafeEqual, generateKeyPairSync} from "node:crypto";
import * as stream from "node:stream";
import assert from "node:assert/strict";
const root = fileURLToPath(new URL("../../crates/bunwasm-runtime/src/js/", import.meta.url));
const provider = webcrypto.subtle;
const signMetadata = {name:provider.sign.name, length:provider.sign.length};
const beforeSign = provider.sign.bind(provider), beforeVerify = provider.verify.bind(provider);
const load = path => (0, eval)(readFileSync(path, "utf8"));
const internal = {
 native:{subtleCrypto:provider, CryptoKey:globalThis.CryptoKey, SubtleCrypto:globalThis.SubtleCrypto,
  randomBytes:n=>new Uint8Array(randomBytes(n)),
  base64Encode:bytes=>Buffer.from(bytes).toString("base64url"),
  base64Decode:value=>new Uint8Array(Buffer.from(value,"base64url")),
  cryptoOp:request=>JSON.stringify(JSON.parse(request).op === "verify" ? {verified:true} : {data:"c2lnbmF0dXJl"}),
 },
 builtin:()=>stream,
 toUint8:a=>ArrayBuffer.isView(a)?new Uint8Array(a.buffer,a.byteOffset,a.byteLength):new Uint8Array(a),
 require:name=>load(root+name+".js")(internal),
};
load(root+"crypto.js")(internal);
const c = internal.crypto;
const path = process.env.NODE_CRYPTO_KEYS_SOURCE || root+"crypto_keys.js";
const keys = load(path)(internal)(Buffer, (a,encoding)=>Buffer.from(a,encoding), timingSafeEqual);
const data = new Uint8Array([1,2,3]);
let failures = 0;
async function check(label, fn) {
 try {await fn();console.log("PASS",label);}
 catch(e){failures++;console.log("FAIL",label,e.name);}
}
for (const name of ["HKDF","PBKDF2"]) await check(name+" raw conversion and native derivation", async()=>{
 const key = keys.createSecretKey(data).toCryptoKey(name,false,["deriveBits"]);
 const native = await provider.importKey("raw",data,name,false,["deriveBits"]);
 const op = {name,hash:"SHA-256",salt:data,info:data,iterations:3};
 assert.deepEqual(await provider.deriveBits(op,key,128),await provider.deriveBits(op,native,128));
 assert.deepEqual(keys.KeyObject.from(key).export(),Buffer.from(data));
 const back = keys.KeyObject.from(native).toCryptoKey(name,false,["deriveBits"]);
 assert.deepEqual(await SubtleCrypto.prototype.deriveBits.call(provider,op,back,128),await provider.deriveBits(op,native,128));
});
for (const extractable of [false,true]) await check("native key policy "+extractable,async()=>{
 const algorithm={name:"HMAC",hash:"SHA-256",length:128};
 const native = await provider.generateKey(algorithm,extractable,["sign","verify"]);
 const object = keys.KeyObject.from(native);
 assert.equal(object.export().length,16);
 const back = object.toCryptoKey(algorithm,extractable,["sign","verify"]);
 assert.equal(back.extractable,extractable);
 assert(await beforeVerify("HMAC",native,await beforeSign("HMAC",back,data),data));
});
const rsa = generateKeyPairSync("rsa",{modulusLength:1024});
const algorithm={name:"RSASSA-PKCS1-v1_5",hash:{name:"SHA-256"}};
const privateKey = keys.KeyObject.from(c.makeKey(algorithm,"private",true,["sign"],rsa.privateKey.export({format:"jwk"})));
const publicKey = keys.KeyObject.from(c.makeKey(algorithm,"public",true,["verify"],rsa.publicKey.export({format:"jwk"})));
for(const padding of [3,4,999]) for(const name of ["sign","verify","createSign","createVerify"]) await check(padding+" "+name,()=>{
 assert.throws(()=>{
  if(name==="sign")return keys.sign("sha256",data,{key:privateKey,padding});
  if(name==="verify")return keys.verify("sha256",data,{key:publicKey,padding},data);
  if(name==="createSign")return keys.createSign("sha256").update(data).sign({key:privateKey,padding});
  return keys.createVerify("sha256").update(data).verify({key:publicKey,padding},data);
 },e=>/ERR_OSSL_/.test(e.code));
});
await check("native-only wrapping algorithm remains usable", async () => {
 const wrapping = await provider.generateKey({name:"AES-OCB",length:128},true,["wrapKey","unwrapKey"]);
 const key = await provider.importKey("raw",new Uint8Array(16),{name:"HMAC",hash:"SHA-256"},true,["sign"]);
 const op = {name:"AES-OCB",iv:new Uint8Array(12)};
 const wrapped = await provider.wrapKey("raw",key,wrapping,op);
 const unwrapped = await provider.unwrapKey("raw",wrapped,wrapping,op,"HKDF",false,["deriveBits"]);
 const bits = await SubtleCrypto.prototype.deriveBits.call(provider,{name:"HKDF",hash:"SHA-256",salt:data,info:data},unwrapped,128);
 assert.equal(bits.byteLength,16);
});
await check("native method receivers and metadata", async () => {
 const key = await provider.generateKey({name:"HMAC",hash:"SHA-256"},true,["sign"]);
 await assert.rejects(async () => Reflect.apply(provider.sign, {}, ["HMAC",key,data]), {name:"TypeError"});
 assert.equal(provider.sign.name,signMetadata.name);
 assert.equal(provider.sign.length,signMetadata.length);
});
await check("native JWK dictionary ignores unrelated getters", async () => {
 const jwk = Object.create({kty:"oct",k:Buffer.alloc(16,1).toString("base64url")});
 Object.defineProperty(jwk,"unrelated",{enumerable:true,get(){throw new Error("unrelated JWK member was read");}});
 const key = await provider.importKey("jwk",jwk,{name:"HMAC",hash:"SHA-256"},false,["sign"]);
 assert.deepEqual(keys.KeyObject.from(key).export(),Buffer.alloc(16,1));
});
await check("RSA validates the padding value it uses", () => {
 let reads = 0;
 const options = {key:privateKey,get padding(){reads++;return reads === 1 ? 999 : 1;}};
 assert.throws(() => keys.sign("sha256",data,options),e=>/ERR_OSSL_/.test(e.code));
 assert.equal(reads,1);
});
assert.equal(provider, webcrypto.subtle);
console.log("failures",failures);
process.exitCode=failures?1:0;
