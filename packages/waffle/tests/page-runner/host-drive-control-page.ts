import { startPage, type HostPageRun } from "waffle/testing/page-runner/page";

declare const HOST_CONTROL: string;
type Request = { mode: string };
declare global {
  interface Window {
    __hostFixture?: { value: number; disposed: number };
  }
}
const originalFetch = globalThis.fetch.bind(globalThis);
let lostTaskAck = false;
if (["retry", "admission-ack", "teardown-report", "final-ack"].includes(HOST_CONTROL)) {
  Reflect.set(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await originalFetch(input, init);
    const body = String(init?.body);
    if (HOST_CONTROL === "final-ack" && body.includes('"kind":"retire-ready"'))
      throw new Error("Lost final ACK");
    if (HOST_CONTROL === "teardown-report" && body.includes('"kind":"case-teardown"'))
      await new Promise((resolve) => setTimeout(resolve, 200));
    if (HOST_CONTROL === "admission-ack" && !lostTaskAck && body.includes('"kind":"case-ready"')) {
      lostTaskAck = true;
      await new Promise((resolve) => setTimeout(resolve, 150));
      throw new Error("Lost admission ACK");
    }
    if (
      HOST_CONTROL === "retry" &&
      !lostTaskAck &&
      String(init?.body).includes('"kind":"task-end"')
    ) {
      lostTaskAck = true;
      throw new Error("Synthetic lost task acknowledgement");
    }
    return response;
  });
}
const run: HostPageRun<Request> = {
  kind: "host",
  async teardown(request, body) {
    const fixture = window.__hostFixture;
    if (fixture) fixture.disposed++;
    if (request.mode === "disposal-fail") throw new Error("DISPOSAL_FAILURE");
    if (request.mode === "disposal-hang") await new Promise(() => {});
    if (["separate-hook", "verdict-delivery", "teardown-report"].includes(request.mode))
      await new Promise((resolve) => setTimeout(resolve, 80));
    if (request.mode === "late-error")
      setTimeout(() => {
        throw new Error("LATE_PAGE_ERROR");
      }, 0);
    return { disposed: fixture?.disposed ?? 0, unavailable: true, bodyStatus: body.status };
  },
};
startPage<Request>({
  list: async () => {
    if (window.__hostFixture) throw new Error("List installed fixture");
    return { ids: ["host", "unselected"] };
  },
  run,
  finish: async (ledger) => {
    if (window.__hostFixture) throw new Error("Finish installed fixture");
    return ledger.slice();
  },
});
