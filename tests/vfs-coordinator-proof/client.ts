import { readRegistry } from "./database.js";
import { failure, type Arm, type Command, type Cursor, type Operation, type Reply, type Request } from "./protocol.js";

export class ProofClient {
  readonly client = crypto.randomUUID();
  sequence = 0;
  nudges = 0;
  cursor: Cursor = { epoch: 0, history: "", generation: 0, watermark: 0, durableWatermark: 0 };
  worker: SharedWorker | undefined;
  private messages = 0;
  private pending = new Map<number, (reply: Reply) => void>();
  async connect(workspace: string, arm: Arm, replace = false): Promise<Reply> {
    return navigator.locks.request(`e5-bootstrap:${workspace}`, async () => {
      const head = await readRegistry(workspace);
      const token = !replace && head && !head.closed ? head.token : crypto.randomUUID();
      this.worker = new SharedWorker(`/authority.js?workspace=${workspace}&token=${token}`, { name: token, type: "module" });
      this.worker.port.onmessage = (event) => this.receive(event.data);
      this.worker.port.start();
      const reply = await this.send({ kind: "initialize", workspace, arm, token, expected: head?.epoch ?? 0 });
      if (reply.kind === "ok") this.cursor = reply.cursor;
      return reply;
    });
  }
  private receive(value: { id?: number; result?: Reply; nudge?: boolean }): void {
    if (value.nudge) { this.nudges++; return; }
    if (value.id === undefined || !value.result) return;
    this.pending.get(value.id)?.(value.result);
    this.pending.delete(value.id);
  }
  send(command: Command, timeoutMs = 3000): Promise<Reply> {
    const id = ++this.messages;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ kind: "error", code: "UNAVAILABLE", message: "UNAVAILABLE: response deadline" }); }, timeoutMs);
      this.pending.set(id, (reply) => { clearTimeout(timer); resolve(reply); });
      this.worker?.port.postMessage({ id, command });
    });
  }
  request(operation: Operation, options: Partial<Request> = {}): Request {
    return { client: this.client, sequence: ++this.sequence, epoch: this.cursor.epoch,
      history: this.cursor.history, actor: "host", operation, ...options };
  }
  async execute(operation: Operation, options: Partial<Request> = {}): Promise<Reply> {
    return this.submit(this.request(operation, options));
  }
  async submit(request: Request): Promise<Reply> {
    const reply = await this.send({ kind: "request", request });
    if (reply.kind === "ok") this.cursor = reply.cursor;
    return reply;
  }
  detach(): void { this.worker?.port.close(); }
}

export async function runGuest(client: ProofClient, path: string, value: string): Promise<unknown> {
  const shared = new SharedArrayBuffer(131072);
  const cells = new Int32Array(shared, 0, 4);
  const bytes = new Uint8Array(shared, 16);
  const worker = new Worker("/guest.js", { type: "module" });
  const encoder = new TextEncoder();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { worker.terminate(); reject(new Error("Guest deadline")); }, 15000);
    worker.onmessage = async (event) => {
      if (event.data.kind !== "syscall") { clearTimeout(timer); worker.terminate(); resolve(event.data); return; }
      const operation: Operation = event.data.operation;
      const reply = await client.execute(operation, { actor: "guest" }).catch(failure);
      const encoded = encoder.encode(JSON.stringify(reply));
      bytes.set(encoded);
      Atomics.store(cells, 1, encoded.length);
      Atomics.store(cells, 0, 1);
      Atomics.notify(cells, 0);
    };
    worker.onerror = (event) => { clearTimeout(timer); worker.terminate(); reject(new Error(event.message)); };
    worker.postMessage({ shared, path, value });
  });
}
