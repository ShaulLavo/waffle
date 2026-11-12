/** Generated factory's private, nonshared linear memory. Never pass it to a guest. */
export interface BufferExports {
  readonly memory: { readonly buffer: ArrayBuffer; grow(pages: number): number };
  readonly [name: string]: unknown;
}
export function instantiate(imports: {
  waffle_tcp_host: {
    io(operation: number, socket: number, pointer: number, length: number): number;
  };
}): BufferExports;
