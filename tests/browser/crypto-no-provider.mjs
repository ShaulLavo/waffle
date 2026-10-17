const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
Object.defineProperty(globalThis, "crypto", {
  value:{getRandomValues}, configurable:true, writable:true,
});
