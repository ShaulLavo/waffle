/** Page-owned fetch metadata. No upstream header or object property can supply this value. */
export interface NetFetchResponseMetadata {
  readonly targetURL: string;
  readonly redirected: boolean;
}

const responses = new WeakMap<Response, NetFetchResponseMetadata>();

/** Record metadata only after the transport has authenticated and validated its reply. */
export function attachNetFetchResponseMetadata(
  response: Response,
  metadata: NetFetchResponseMetadata,
): void {
  const url = new URL(metadata.targetURL);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hash)
    throw new TypeError("Invalid fetch transport URL");
  if (typeof metadata.redirected !== "boolean")
    throw new TypeError("Invalid fetch redirect metadata");
  responses.set(response, Object.freeze({ targetURL: url.href, redirected: metadata.redirected }));
}

export function readNetFetchResponseMetadata(
  response: Response,
): NetFetchResponseMetadata | undefined {
  return responses.get(response);
}
