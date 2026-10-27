// Preview transport between the service worker and pages hosting a server.
export interface PreviewAsk {
  type: "preview-request";
  port: number;
  method: string;
  target: string;
  headers: [string, string][];
  body: ArrayBuffer | null;
}

export type PreviewReply =
  | { type: "none" }
  | { type: "accepted" }
  | { type: "head"; status: number; statusText: string; headers: [string, string][] }
  | { type: "data"; chunk: Uint8Array }
  | { type: "end" }
  | { type: "error"; message: string };

export type PreviewSocketAsk = { type: "preview-socket-probe" | "preview-socket"; port: number };
export type PreviewMessage = PreviewAsk | PreviewSocketAsk;
