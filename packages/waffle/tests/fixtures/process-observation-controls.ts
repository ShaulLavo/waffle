export const observationModule = new WebAssembly.Module(
  new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 2, 12, 1, 3, 101, 110, 118, 4, 104, 101, 108,
    100, 0, 0, 3, 2, 1, 0, 5, 3, 1, 0, 1, 7, 19, 2, 6, 109, 101, 109, 111, 114, 121, 2, 0, 6, 95,
    115, 116, 97, 114, 116, 0, 1, 10, 6, 1, 4, 0, 16, 0, 11,
  ]),
);

export async function awaitObservationBarrier(predicate: () => boolean) {
  const end = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("process observation timeout");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
