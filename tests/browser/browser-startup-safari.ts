import assert from "node:assert/strict";

assert.equal(process.platform, "darwin", "Run this check on the Mac fleet host");
const requestedUrl = process.argv[2];
assert.ok(requestedUrl, "Pass the URL of a playground built on the PC and served with COOP/COEP headers");
const url = new URL(requestedUrl).href;
const port = Number(process.env.SAFARI_DRIVER_PORT ?? 43189);
const origin = `http://127.0.0.1:${port}`;
let driver: ReturnType<typeof Bun.spawn> | undefined;
let session: string | undefined;
let device: string | undefined;
let stopping = false;
let cleaning: Promise<void> | undefined;
const report: Record<string, unknown> = { url };
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
async function request(path: string, method = "GET", body?: unknown): Promise<unknown> {
  const response = await fetch(origin + path, { method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(stopping ? 5_000 : 120_000) });
  const result: unknown = await response.json();
  assert.ok(record(result), `Safari returned no response during ${report.phase}`);
  if (!response.ok) throw new Error(JSON.stringify(result));
  return result.value;
}
async function evaluate(script: string, args: unknown[] = []): Promise<unknown> {
  const result = await request(`/session/${session}/execute/async`, "POST", {
    script: `const done=arguments[arguments.length-1]; Promise.resolve().then(async()=>{${script}}).then(value=>done({ok:true,value}),error=>done({ok:false,error:String(error),stack:error?.stack}));`, args,
  });
  assert.ok(record(result), `Safari returned no script result during ${report.phase}`);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}
async function ready(): Promise<void> {
  await evaluate("const end=Date.now()+30000; while(!globalThis.playground||document.querySelector('#status')?.dataset.kind!=='ok'){const status=document.querySelector('#status');if(status?.dataset.kind==='error'||Date.now()>end)throw Error(status?.textContent||'Startup timed out');await new Promise(r=>setTimeout(r,25));} return true;");
}
async function navigate(target = url): Promise<void> {
  await request(`/session/${session}/url`, "POST", { url: target });
  const expected = new URL(target).href, deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const state = await request(`/session/${session}/execute/sync`, "POST", { script: "return {url:location.href,ready:document.readyState};", args: [] });
    if (record(state) && state.url === expected && state.ready === "complete") return;
    await Bun.sleep(25);
  }
  throw new Error(`Safari did not finish navigating to ${expected}`);
}
function cleanup(): Promise<void> {
  stopping = true;
  return cleaning ??= (async () => {
    if (session) await request(`/session/${session}`, "DELETE").catch(error => { report.sessionCleanupError = String(error); });
    if (driver) { driver.kill(); await driver.exited; }
    report.cleanup = { driverStopped: true, sessionClosed: !report.sessionCleanupError };
  })();
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void cleanup().finally(() => process.exit(1)); });
const deadline = setTimeout(() => { void cleanup().finally(() => process.exit(1)); }, 240_000);
try {
  const occupied = await fetch(`${origin}/status`, { signal: AbortSignal.timeout(500) }).then(() => true, () => false);
  assert.equal(occupied, false, "The Safari driver port must be unused");
  driver = Bun.spawn(["/usr/bin/safaridriver", "--port", String(port)], { stdout: "ignore", stderr: "ignore" });
  for (let attempts = 0; ; attempts++) {
    try { await request("/status"); break; }
    catch (error) { if (attempts === 30) throw error; await Bun.sleep(100); }
  }
  const capabilities = process.env.SAFARI_IOS === "1"
    ? { browserName: "safari", platformName: "ios", "safari:useSimulator": true, "safari:deviceType": "iPhone", "safari:deviceName": "iPhone 17 Pro" }
    : { browserName: "safari" };
  const opened = await request("/session", "POST", { capabilities: { alwaysMatch: capabilities } });
  assert.ok(record(opened) && typeof opened.sessionId === "string");
  session = opened.sessionId;
  report.capabilities = opened.capabilities;
  if (record(opened.capabilities) && typeof opened.capabilities["safari:deviceUDID"] === "string") device = opened.capabilities["safari:deviceUDID"];
  await request(`/session/${session}/timeouts`, "POST", { script: 120_000, pageLoad: 60_000, implicit: 0 });
  if (process.env.SAFARI_SEED_URL) {
    await navigate(process.env.SAFARI_SEED_URL); await ready();
    const seed = await evaluate(`
      await playground.fs.writeFile('/safari-startup.txt','durable Safari edit'); await playground.fs.flush();
      const get=request=>new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)});
      const db=await get(indexedDB.open('bun-wasm-workspace'));
      const stores=Array.from(db.objectStoreNames),tx=db.transaction(stores,'readonly');
      const rows=await Promise.all(stores.map(async name=>{const store=tx.objectStore(name);const [keys,values]=await Promise.all([get(store.getAllKeys()),get(store.getAll())]);return {name,keys,values:values.map(value=>value instanceof Uint8Array?{bytes:Array.from(value)}:{json:value})}}));
      db.close(); return rows;
    `);
    await navigate(new URL("__safari-empty.html", url).href);
    await evaluate(`
      const rows=arguments[0];
      const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('bun-wasm-workspace',1);request.onupgradeneeded=()=>{for(const row of rows)request.result.createObjectStore(row.name)};request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)});
      const tx=db.transaction(rows.map(row=>row.name),'readwrite');
      for(const row of rows)row.values.forEach((value,index)=>tx.objectStore(row.name).put(value.bytes?new Uint8Array(value.bytes):value.json,row.keys[index]));
      await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error)});db.close();return true;
    `, [seed]);
    report.seedUrl = process.env.SAFARI_SEED_URL;
  }
  report.phase = "initial startup";
  await navigate(); await ready();
  assert.equal(await evaluate("return globalThis.crossOriginIsolated;"), true);
  if (process.env.SAFARI_SEED_URL) assert.equal(await evaluate("return new TextDecoder().decode(await playground.fs.readFile('/safari-startup.txt'));"), "durable Safari edit");
  await evaluate("await playground.fs.writeFile('/safari-startup.txt','durable Safari edit'); await playground.fs.flush('/safari-startup.txt'); return true;");
  for (let reload = 0; reload < 3; reload++) {
    report.phase = `reload ${reload + 1}`;
    await request(`/session/${session}/refresh`, "POST", {}); await ready();
    assert.equal(await evaluate("return new TextDecoder().decode(await playground.fs.readFile('/safari-startup.txt'));"), "durable Safari edit");
  }
  report.reloads = 3;
  report.phase = "owner window";
  const owner = await request(`/session/${session}/window`);
  report.phase = "new tab";
  const contender = await request(`/session/${session}/window/new`, "POST", { type: "tab" });
  assert.ok(record(contender) && typeof contender.handle === "string");
  report.phase = "switch tab";
  await request(`/session/${session}/window`, "POST", { handle: contender.handle });
  report.phase = "contender navigation";
  await navigate();
  report.windows = await request(`/session/${session}/window/handles`);
  report.currentWindow = await request(`/session/${session}/window`);
  report.phase = "contender synchronous state";
  report.document = await request(`/session/${session}/execute/sync`, "POST", { script: "return {url:location.href,ready:document.readyState,status:document.querySelector('#status')?.textContent,kind:document.querySelector('#status')?.dataset.kind};", args: [] });
  await ready();
  assert.equal(await evaluate("return new TextDecoder().decode(await playground.fs.readFile('/safari-startup.txt'));"), "durable Safari edit");
  await request(`/session/${session}/window`, "POST", { handle: owner });
  report.phase = "displaced owner diagnostic";
  const diagnostic = await evaluate("const end=Date.now()+15000;while(!playground.fs.ownershipLost){if(Date.now()>end)throw Error('Displacement was not reported');await new Promise(r=>setTimeout(r,25));}const status=document.querySelector('#status');return {message:status.textContent,whiteSpace:getComputedStyle(status).whiteSpace,clipped:status.scrollWidth>status.clientWidth||status.scrollHeight>status.clientHeight,retry:document.querySelector('#run')?.textContent,editor:!!globalThis.playground};");
  report.diagnostic = diagnostic;
  if (process.env.SAFARI_SCREENSHOT) {
    const screenshot = await request(`/session/${session}/screenshot`);
    if (typeof screenshot === "string") await Bun.write(process.env.SAFARI_SCREENSHOT, Buffer.from(screenshot, "base64"));
  }
  assert.ok(record(diagnostic) && typeof diagnostic.message === "string");
  assert.match(diagnostic.message, /This workspace was opened in another tab. Reload to continue here./);
  assert.match(diagnostic.message, /Unsaved changes in this tab weren't kept./);
  assert.equal(diagnostic.whiteSpace, "pre-wrap"); assert.equal(diagnostic.clipped, false);
  assert.equal(diagnostic.retry, "Reload"); assert.equal(diagnostic.editor, true);
  await request(`/session/${session}/window`, "POST", { handle: contender.handle });
  await request(`/session/${session}/window`, "DELETE");
  await request(`/session/${session}/window`, "POST", { handle: owner });
  report.phase = "recovery";
  await request(`/session/${session}/refresh`, "POST", {});
  await ready();
  assert.equal(await evaluate("return new TextDecoder().decode(await playground.fs.readFile('/safari-startup.txt'));"), "durable Safari edit");
  await evaluate("await playground.fs.remove('/safari-startup.txt'); await playground.fs.flush(); return true;");
  report.recovered = true;
  report.ok = true;
  console.log("Safari playground: fresh startup, three durable reloads, newest writer wins, complete displacement diagnostic and retry passed");
} catch (error) {
  report.error = error instanceof Error ? error.stack || String(error) : String(error);
  if (device && process.env.SAFARI_SCREENSHOT) {
    const screenshot = Bun.spawnSync(["xcrun", "simctl", "io", device, "screenshot", process.env.SAFARI_SCREENSHOT], { stdout: "ignore", stderr: "ignore" });
    report.failureScreenshot = screenshot.exitCode === 0;
  }
  throw error;
} finally {
  clearTimeout(deadline); await cleanup();
  if (process.env.SAFARI_OUTPUT) await Bun.write(process.env.SAFARI_OUTPUT, JSON.stringify(report, null, 2) + "\n");
}
