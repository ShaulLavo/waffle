// The real notification relay, with full garbage collections running while its waits are pending.
// iOS Safari 26.5 was observed to stop forwarding every armed word from an idle relay; collecting
// often makes any wait that only native code references as likely to be lost as possible.
import "../../browser/notification-worker.ts";

const collect = (globalThis as unknown as { Bun: { gc(full: boolean): void } }).Bun.gc;
setInterval(() => collect(true), 2);
