const provider = globalThis.crypto.subtle;
const original = Object.fromEntries(["generateKey","importKey","unwrapKey","wrapKey"].map(name => [name,provider[name].bind(provider)]));
const aes = a => (typeof a === "string" ? a : a?.name)?.toUpperCase().startsWith("AES-");
const unsupported = () => Promise.reject(new DOMException("192-bit AES keys are not supported","OperationError"));
provider.generateKey = (a,extractable,usages) => aes(a) && a.length === 192 ? unsupported() : original.generateKey(a,extractable,usages);
provider.importKey = (format,data,a,extractable,usages) => {
  const bytes = format === "raw" ? data.byteLength : format === "jwk" && data.k ? Buffer.from(data.k,"base64url").length : 0;
  return aes(a) && bytes === 24 ? unsupported() : original.importKey(format,data,a,extractable,usages);
};
provider.unwrapKey = (format,wrapped,key,a,target,extractable,usages) =>
  original.unwrapKey(format,wrapped,key,a,target,extractable,usages).then(result =>
    aes(target) && result.algorithm.length === 192 ? unsupported() : result,
  );
provider.wrapKey = (format,key,wrapping,a) => format === "jwk" && (typeof a === "string" ? a : a.name) === "AES-KW"
  ? Promise.reject(new DOMException("JWK is not aligned","DataError"))
  : original.wrapKey(format,key,wrapping,a);
