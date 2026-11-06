/** Cloneable launch authority. Never supplied by a guest or inherited by its children. */
export interface GraphicsConnection {
  readonly port: MessagePort;
  readonly gpu: boolean;
  /** Launch-wide revocation remains observable before any open message is delivered. */
  readonly revocation: SharedArrayBuffer;
  readonly surfaces: readonly { readonly id: number; readonly info: SharedArrayBuffer }[];
  readonly commandBytes: number;
  readonly completionBytes: number;
}
export interface GraphicsGrant {
  readonly connection: GraphicsConnection;
  /** Logical revocation is synchronous; retirement joins the ordered service acknowledgement. */
  dispose(): void;
  retired(): Promise<void>;
}
export interface GraphicsOpen {
  readonly type: "open";
  readonly id: number;
  readonly control: SharedArrayBuffer;
  readonly commands: SharedArrayBuffer;
  readonly replies: SharedArrayBuffer;
}
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
  | { readonly type: "retired"; readonly grant: number }
  | { readonly type: "closed"; readonly grant: number; readonly id: number };
