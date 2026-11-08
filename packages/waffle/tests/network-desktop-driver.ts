import { PlaywrightDriver } from "waffle/testing/page-runner/playwright";

const snapshot = `return (async()=>{
  const registrations=await navigator.serviceWorker.getRegistrations();
  const root=registrations.find(r=>r.scope===location.origin+'/');
  if(!root?.active)throw Error('Foreign root sentinel disappeared');
  const channel=new MessageChannel();
  const identity=new Promise(resolve=>channel.port1.onmessage=e=>{channel.port1.close();resolve(e.data)});
  root.active.postMessage('identity',[channel.port2]);
  return JSON.stringify({scope:root.scope,script:root.active.scriptURL,identity:await identity,keys:(await caches.keys()).sort()});
})()`;
/** The normal positive command also proves that unrelated root storage survives each phase. */
export class NetworkDesktopDriver extends PlaywrightDriver {
  private before: string | undefined;
  override async navigate(url: string, signal: AbortSignal): Promise<void> {
    if (this.before === undefined) {
      await super.navigate(new URL("/foreign.html", url).href, signal);
      this.before = await this.capture(
        `const r=await navigator.serviceWorker.register('/sentinel-sw.js',{scope:'/'});
        while(r.active?.state!=='activated')await new Promise(resolve=>setTimeout(resolve,5));
        await caches.open('foreign-sentinel-'+crypto.randomUUID());
        ${snapshot}`,
        signal,
      );
    }
    return super.navigate(url, signal);
  }
  private async capture(source: string, signal: AbortSignal): Promise<string> {
    await this.script(
      `window.__networkSentinel = {kind:'pending'};
      void (async()=>{${source}})().then(
        value=>window.__networkSentinel={kind:'done',value},
        error=>window.__networkSentinel={kind:'failed',detail:String(error)});
      return null;`,
      signal,
    );
    for (;;) {
      signal.throwIfAborted();
      const state = await this.script("return window.__networkSentinel", signal);
      if (!state || typeof state !== "object" || !("kind" in state))
        throw new Error("Missing sentinel observation");
      if (state.kind === "done" && "value" in state && typeof state.value === "string")
        return state.value;
      if (state.kind === "failed" && "detail" in state) throw new Error(String(state.detail));
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  override async stop() {
    let failure: { error: unknown } | undefined;
    try {
      if (this.before !== undefined) {
        const after = await this.capture(snapshot, AbortSignal.timeout(2000));
        if (after !== this.before)
          throw new Error("Foreign root registration, active Worker UUID or cache keys changed");
        console.log(
          JSON.stringify({ ownership: "network foreign root unchanged", snapshot: after }),
        );
      }
    } catch (error) {
      failure = { error };
    }
    const cleanup = await super.stop();
    if (failure) throw failure.error;
    return cleanup;
  }
}
