import { classify } from "./probe-classifier.js";
function growable(maxByteLength: number): SharedArrayBuffer {
  const value: unknown = Reflect.construct(SharedArrayBuffer, [0, { maxByteLength }]);
  if (
    !(value instanceof SharedArrayBuffer) ||
    Reflect.get(value, "maxByteLength") !== maxByteLength ||
    Reflect.get(value, "growable") !== true
  )
    throw new TypeError("Growable shared-buffer measurement is unavailable");
  return value;
}
const retained: object[] = [];
self.onmessage = () => {
  try {
    self.postMessage(classify(growable, retained));
    // Retain every successful reservation until the owning worker terminates.
    void retained.length;
  } catch (error) {
    setTimeout(() => {
      throw error;
    });
  }
};
