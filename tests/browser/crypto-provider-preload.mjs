{
const provider = globalThis.crypto.subtle;
const key = await provider.generateKey({name:"HMAC", hash:"SHA-256"}, false, ["sign", "verify"]);
globalThis.__cryptoBeforeBoot = {provider, key, Key:globalThis.CryptoKey,
  sign:provider.sign.bind(provider), verify:provider.verify.bind(provider)};
}
