export type RelayMode = "selected" | "websocket" | "bad-certificate";
export interface RelayBrowserConfig {
  readonly endpoint: string;
  readonly token: string;
  readonly native: boolean;
  readonly targets: Readonly<
    Record<"echo" | "ssl" | "refused" | "denied", { host: string; port: number }>
  >;
}
export interface RelayProbe {
  constructed: number;
  ready: number;
  streams: number;
  fragments: number;
  closed: number;
  failures: string[];
}
export interface RelayModeResult {
  readonly mode: RelayMode;
  readonly carrier: "webtransport" | "websocket";
  readonly probe: RelayProbe;
  readonly helperBytes: number;
  readonly preview1: { echo: number; denied: number; reset: number };
  readonly fallbackMs: number;
}
