// Bun's network policy adapter. Generic I/O and ring handling belong to the runtime;
// only Bun's installer download cache is selected here.
import { NetHelper as RuntimeNetHelper, type NetHelperHooks } from "@bun-wasm/runtime/browser/net/helper";
import { installFetch } from "./install-cache";

export type { ConnectionSink, NetFetch, NetHelperHooks, PreviewConnection, PreviewSink } from "@bun-wasm/runtime/browser/net/helper";

export class NetHelper extends RuntimeNetHelper {
  constructor(sab: SharedArrayBuffer, hooks: NetHelperHooks = {}) {
    super(sab, installFetch, hooks);
  }
}
