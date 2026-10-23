export function withLateBigintHooks<T>(action: () => T): { value: T; calls: number } {
  const constructor = Object.getOwnPropertyDescriptor(globalThis, "BigInt")!;
  const method = Object.getOwnPropertyDescriptor(BigInt.prototype, "toString")!;
  const prototype = BigInt.prototype;
  let calls = 0;
  Object.defineProperty(globalThis, "BigInt", {
    ...constructor,
    value: new Proxy(BigInt, {
      apply(target, receiver, args) {
        calls++;
        return Reflect.apply(target, receiver, args);
      },
    }),
  });
  Object.defineProperty(prototype, "toString", {
    ...method,
    value(this: bigint, radix?: number) {
      calls++;
      return radix === 16 ? "10000000000000001" : Reflect.apply(method.value, this, [radix]);
    },
  });
  try {
    return { value: action(), calls };
  } finally {
    Object.defineProperty(globalThis, "BigInt", constructor);
    Object.defineProperty(prototype, "toString", method);
  }
}
