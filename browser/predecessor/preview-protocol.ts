// Messages between the service worker (sw.ts) and the playground page (preview.ts).
//
// The service worker intercepts requests under `<app>/__preview/<port>/` and posts a PreviewAsk to
// every playground window with a MessagePort for the answer. The window running a guest server on
// that port answers on the port: accepted, head, data…, end (or error). Other windows answer none.

export const PREVIEW_DIR = "__preview";

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
