// The I/O side of the networking bridge. One NetHelper per running bun worker. It lives on a thread
// that has an event loop (the page in the browser, a Bun worker in scripts/run.ts), receives the
// worker's NetRequests, performs real `fetch`es, runs virtual preview connections, and writes every
// result into the worker's ring.

import { type ResponseHead, type ResponseSink, ResponseParser, type PreviewRequest, serializeRequest } from "./http1";
import { CONN_BASE, FETCH_WINDOW, type FetchHead, Kind, MAX_RECORD, type NetError, type NetRequest, type NewConn } from "./protocol";
import { RingWriter } from "./ring";

const encoder = new TextEncoder();
/** Hostnames that mean "this machine": fetches to them may reach the guest's own servers. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]", "[::]"]);
const json = (value: unknown) => encoder.encode(JSON.stringify(value));

interface FetchJob {
  controller: AbortController;
  /** Body bytes sent minus bytes the guest has read. */
  inFlight: number;
  /** Resolves a pump waiting for the guest to catch up. */
  wake: (() => void) | null;
}

interface Connection {
  parser: ResponseParser;
  sink: ResponseSink;
}

export interface NetHelperHooks {
  /** A guest server started listening on `port`. */
  listening?(port: number, host: string): void;
  /** That server stopped (closed, or its worker ended). */
  stopped?(port: number): void;
}

/** Streams a preview response back to whoever asked (the service worker, a test). */
export type PreviewSink = ResponseSink;

export class NetHelper {
  private ring: RingWriter;
  private fetches = new Map<number, FetchJob>();
  private listeners = new Map<number, number>(); // listener handle -> port
  private connections = new Map<number, Connection>();
  private nextConn = CONN_BASE;
  private disposed = false;

  constructor(
    sab: SharedArrayBuffer,
    private hooks: NetHelperHooks = {},
  ) {
    this.ring = new RingWriter(sab);
  }

  handle(req: NetRequest): void {
    if (this.disposed) return;
    switch (req.type) {
      case "fetch":
        void this.fetch(req);
        return;
      case "ack":
        this.ack(req.id, req.bytes);
        return;
      case "close":
        this.close(req.id);
        return;
      case "listen":
        this.listeners.set(req.id, req.port);
        this.hooks.listening?.(req.port, req.host);
        return;
      case "write":
        this.connections.get(req.id)?.parser.push(req.data);
        return;
    }
  }

  /** The worker ended: abort fetches, fail open preview requests, forget listeners. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const job of this.fetches.values()) job.controller.abort();
    this.fetches.clear();
    for (const conn of this.connections.values()) conn.sink.error("the server stopped");
    this.connections.clear();
    for (const port of this.listeners.values()) this.hooks.stopped?.(port);
    this.listeners.clear();
  }

  /** The listener handle for `port`, if this worker is serving it. */
  listenerFor(port: number): number | undefined {
    for (const [id, p] of this.listeners) if (p === port) return id;
    return undefined;
  }

  /**
   * Delivers `req` to the guest server on `port` as a new connection and streams the parsed response
   * into `sink`. Returns false when nothing listens there.
   */
  request(port: number, req: PreviewRequest, sink: PreviewSink): boolean {
    const listener = this.listenerFor(port);
    if (listener === undefined || this.disposed) return false;
    const conn = this.nextConn++;
    // Once the response is complete, tell the guest the client is done (EOF) so it closes its side.
    const finish: PreviewSink = {
      head: (head: ResponseHead) => sink.head(head),
      data: (chunk) => sink.data(chunk),
      end: () => {
        this.connections.delete(conn);
        sink.end();
        void this.ring.write(conn, Kind.End);
      },
      error: (message) => {
        this.connections.delete(conn);
        sink.error(message);
      },
    };
    this.connections.set(conn, { parser: new ResponseParser(finish, req.method === "HEAD"), sink: finish });
    const announce: NewConn = { conn, peer: { address: "127.0.0.1", port: 40000 + (conn % 20000), family: "IPv4" } };
    void this.deliver(listener, conn, json(announce), serializeRequest(req, `localhost:${port}`));
    return true;
  }

  // ---------- fetch ----------

  private async fetch(req: NetRequest & { type: "fetch" }): Promise<void> {
    const job: FetchJob = { controller: new AbortController(), inFlight: 0, wake: null };
    this.fetches.set(req.id, job);
    const port = this.loopbackPort(req.url);
    if (port !== undefined) {
      this.loopback(req, port);
      return;
    }
    let response: Response;
    try {
      response = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body as BodyInit | null,
        redirect: req.redirect,
        signal: job.controller.signal,
      });
    } catch (err) {
      await this.failFetch(req.id, err);
      return;
    }
    if (!this.fetches.has(req.id)) return;
    const head: FetchHead = {
      status: response.status,
      statusText: response.statusText,
      url: response.url,
      redirected: response.redirected,
      headers: Array.from(response.headers),
    };
    await this.ring.write(req.id, Kind.Head, json(head));
    await this.pumpBody(req.id, job, response.body);
  }

  private async pumpBody(id: number, job: FetchJob, body: ReadableStream<Uint8Array> | null): Promise<void> {
    const reader = body?.getReader();
    try {
      for (;;) {
        if (!reader) break;
        const { done, value } = await reader.read();
        if (done) break;
        if (!this.fetches.has(id)) return;
        for (let at = 0; at < value.length; at += MAX_RECORD) {
          const piece = value.subarray(at, at + MAX_RECORD);
          await this.waitForWindow(id, job);
          if (!this.fetches.has(id)) return;
          job.inFlight += piece.length;
          await this.ring.write(id, Kind.Data, piece);
        }
      }
    } catch (err) {
      await this.failFetch(id, err);
      return;
    }
    if (!this.fetches.has(id)) return;
    this.fetches.delete(id);
    await this.ring.write(id, Kind.End);
  }

  /** The port when `url` addresses one of this worker's own servers (http://localhost:<port>/…). */
  private loopbackPort(url: string): number | undefined {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" || !LOOPBACK.has(parsed.hostname)) return undefined;
    const port = Number(parsed.port || 80);
    return this.listenerFor(port) === undefined ? undefined : port;
  }

  /**
   * A fetch to the guest's own server, over a virtual connection: the page's network can't reach
   * it. (Redirects are not followed; the response comes back as the server sent it.)
   */
  private loopback(req: NetRequest & { type: "fetch" }, port: number): void {
    const id = req.id;
    const live = () => this.fetches.has(id);
    const finish = (kind: number, payload?: Uint8Array) => {
      if (!live()) return;
      this.fetches.delete(id);
      void this.ring.write(id, kind, payload);
    };
    const url = new URL(req.url);
    this.request(port, { method: req.method, target: url.pathname + url.search, headers: req.headers, body: req.body }, {
      head: (head) => {
        if (live()) void this.ring.write(id, Kind.Head, json({ ...head, url: req.url, redirected: false } satisfies FetchHead));
      },
      data: (chunk) => {
        if (live()) void this.writeChunks(id, chunk);
      },
      end: () => finish(Kind.End),
      error: (message) => finish(Kind.Error, json({ name: "TypeError", message } satisfies NetError)),
    });
  }

  /** Backpressure: don't send more than FETCH_WINDOW bytes ahead of what the guest has read. */
  private async waitForWindow(id: number, job: FetchJob): Promise<void> {
    while (job.inFlight >= FETCH_WINDOW && this.fetches.has(id)) {
      await new Promise<void>((resolve) => (job.wake = resolve));
    }
  }

  private ack(id: number, bytes: number): void {
    const job = this.fetches.get(id);
    if (!job) return;
    job.inFlight -= bytes;
    const wake = job.wake;
    job.wake = null;
    wake?.();
  }

  private async failFetch(id: number, err: unknown): Promise<void> {
    if (!this.fetches.has(id)) return; // closed by the guest: the abort is expected
    this.fetches.delete(id);
    // Pass the engine's own wording through ("Failed to fetch" in Chromium, "Load failed" in WebKit).
    const error: NetError =
      err instanceof Error ? { name: err.name || "TypeError", message: err.message } : { name: "TypeError", message: String(err) };
    await this.ring.write(id, Kind.Error, json(error));
  }

  // ---------- listeners and connections ----------

  private close(id: number): void {
    const job = this.fetches.get(id);
    if (job) {
      this.fetches.delete(id);
      job.controller.abort();
      job.wake?.();
      return;
    }
    const port = this.listeners.get(id);
    if (port !== undefined) {
      this.listeners.delete(id);
      this.hooks.stopped?.(port);
      return;
    }
    const conn = this.connections.get(id);
    if (conn) {
      this.connections.delete(id);
      conn.parser.end();
    }
  }

  private async deliver(listener: number, conn: number, announce: Uint8Array, bytes: Uint8Array): Promise<void> {
    await this.ring.write(listener, Kind.Conn, announce);
    await this.writeChunks(conn, bytes);
  }

  /** Data records for `bytes`, split to fit the ring's record size. */
  private async writeChunks(handle: number, bytes: Uint8Array): Promise<void> {
    for (let at = 0; at < bytes.length; at += MAX_RECORD) {
      await this.ring.write(handle, Kind.Data, bytes.subarray(at, at + MAX_RECORD));
    }
  }
}
