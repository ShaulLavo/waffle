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
  private before: unknown;
  override async navigate(url: string, signal: AbortSignal): Promise<void> {
    if (this.before === undefined) {
      await super.navigate(new URL("/foreign.html", url).href, signal);
      await this.script(
        `return (async()=>{
        const r=await navigator.serviceWorker.register('/sentinel-sw.js',{scope:'/'});
        while(r.active?.state!=='activated')await new Promise(resolve=>setTimeout(resolve,5));
        await caches.open('foreign-sentinel-'+crypto.randomUUID());
        return null;
      })()`,
        signal,
      );
      this.before = await this.script(snapshot, signal);
    }
    return super.navigate(url, signal);
  }
  override async stop() {
    let failure: { error: unknown } | undefined;
    try {
      if (this.before !== undefined) {
        const after = await this.script(snapshot, AbortSignal.timeout(2000));
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
