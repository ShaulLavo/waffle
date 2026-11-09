const brand: unique symbol = Symbol("graphics control retention");
export interface GraphicsControlRetention {
  readonly [brand]: true;
}
const issued = new WeakSet<object>();
/** Private ticket issuance. Neither the token nor this module enters a guest bundle. */
export function issueGraphicsRetention(): GraphicsControlRetention {
  const retention = Object.freeze({ [brand]: true as const });
  issued.add(retention);
  return retention;
}
export function validGraphicsRetention(value: unknown): value is GraphicsControlRetention {
  return typeof value === "object" && value !== null && issued.has(value);
}
