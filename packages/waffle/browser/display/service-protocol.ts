import type { GraphicsOpen } from "./protocol.js";

export interface ServiceSurface {
  readonly id: number;
  readonly canvas?: OffscreenCanvas;
}
export type GpuServiceRequest =
  | {
      readonly type: "open";
      readonly grant: number;
      readonly open: GraphicsOpen;
      readonly surfaces: readonly ServiceSurface[];
    }
  | { readonly type: "close"; readonly grant: number; readonly id: number }
  | { readonly type: "revoke"; readonly grant: number }
  | { readonly type: "tick" }
  | { readonly type: "surface-dispose"; readonly id: number };
export type GpuServiceReply =
  | { readonly type: "retirement-failed"; readonly grant: number }
  | { readonly type: "retired"; readonly grant: number }
  | { readonly type: "closed"; readonly grant: number; readonly id: number };

export interface ServiceBootstrap {
  readonly type: "bootstrap";
  readonly readers: SharedArrayBuffer;
  readonly incarnation: number;
}
