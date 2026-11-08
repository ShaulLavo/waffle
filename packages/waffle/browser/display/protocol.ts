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
  readonly arena: SharedArrayBuffer;
}
