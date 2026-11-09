type ControlResult = {
  engine: string;
  control: string;
  status: "pass" | "fail";
  error?: string;
};

export class ControlRun {
  readonly results: ControlResult[] = [];
  private readonly controller = new AbortController();
  private readonly interrupted = () => {
    this.controller.abort(new Error("Browser controls interrupted"));
  };
  constructor() {
    process.on("SIGINT", this.interrupted);
    process.on("SIGTERM", this.interrupted);
  }
  throwIfInterrupted(): void {
    this.controller.signal.throwIfAborted();
  }
  close(): void {
    process.removeListener("SIGINT", this.interrupted);
    process.removeListener("SIGTERM", this.interrupted);
  }
  async check(engine: string, control: string, run: () => Promise<void>): Promise<void> {
    this.throwIfInterrupted();
    try {
      await run();
      this.throwIfInterrupted();
      this.results.push({ engine, control, status: "pass" });
    } catch (error) {
      this.results.push({ engine, control, status: "fail", error: String(error) });
    }
    console.log(JSON.stringify(this.results[this.results.length - 1]));
  }
}
