import assert from "node:assert/strict";
import {oversizedCryptoInput} from "../src/crypto-inputs.js";
const big = new Uint8Array(2 ** 31);
const small = new Uint8Array(16);
const cases = [
  ["digest",["SHA-256",big]],
  ["encrypt",[{name:"AES-GCM",iv:small},null,big]],
  ["decrypt",[{name:"AES-GCM",iv:small},null,big]],
  ["sign",["HMAC",null,big]],
  ["verify",["HMAC",null,small,big]],
  ["verify",["HMAC",null,big,small]],
  ["importKey",["raw",big,{name:"AES-GCM"},false,["encrypt"]]],
  ["unwrapKey",["raw",big,null,{name:"AES-GCM",iv:small},{name:"AES-GCM"},false,["encrypt"]]],
  ["encrypt",[{name:"AES-GCM",iv:small,additionalData:big},null,small]],
  ["encrypt",[{name:"AES-CBC",iv:big},null,small]],
  ["deriveBits",[{name:"HKDF",hash:"SHA-256",salt:big,info:small},null,256]],
  ["generateKey",[{name:"RSA-OAEP",modulusLength:2048,publicExponent:big,hash:"SHA-256"},true,["encrypt"]]],
];
for (const [operation,args] of cases) assert(oversizedCryptoInput(operation,args),operation);
assert.equal(oversizedCryptoInput("digest",["SHA-256",small]),false);
assert.equal(oversizedCryptoInput("generateKey",[{name:"HMAC",hash:"SHA-256",length:128,get iv(){throw new Error("unused member");}},true,["sign"]]),false);
console.log("oversized input guards",cases.length);
