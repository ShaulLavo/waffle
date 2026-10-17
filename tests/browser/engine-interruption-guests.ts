// Shared verbatim by real WASM-worker cases and the native Node reference tests.
// Checkpoints preserve authoritative pending SIGINT without dequeuing it or
// entering guest JavaScript. The event loop alone dequeues and dispatches it.
function protectedLoop(ready: "ready" | "handler-ready"): string {
  // The host may interrupt as soon as it observes this unbuffered write. Emit it
  // inside try, so readiness proves that catch/finally are already in scope.
  return `try { fs.writeSync(2,'${ready}\\n'); while (true) {} } catch (error) { fs.writeSync(2,'CATCH-RAN\\n'); } finally { fs.writeSync(2,'FINALLY-RAN\\n'); } fs.writeSync(2,'AFTER-RAN\\n');`;
}

export function defaultSignalGuest(): string {
  return `const fs=require('node:fs'); ${protectedLoop("ready")}`;
}

export function handledSignalGuest(nested = false, cpuMs = 1_000): string {
  return `const fs=require('node:fs');
    let count=0,loopFinished=false,turns=0;
    const missing=setTimeout(()=>{throw Error('queued SIGINT was not dispatched');},3000);
    process.on('SIGINT',()=>{
      if(!loopFinished)throw Error('SIGINT callback reentered synchronous CPU work');
      clearTimeout(missing);count++;
      ${nested ? protectedLoop("handler-ready") : `fs.writeSync(2,'handled\\n'); setImmediate(()=>{console.log('continued',count,turns>0);process.exit(23);});`}
    });
    fs.writeSync(2,'ready\\n');
    const end=Date.now()+${cpuMs};
    while(Date.now()<end){for(let i=0;i<10000;i++)turns++;}
    if(count!==0)throw Error('handled SIGINT ran before the synchronous loop yielded');
    loopFinished=true;fs.writeSync(2,'loop-finished\\n');`;
}

export const idleSignalGuest = `const fs=require('node:fs');
  const keepAlive=setInterval(()=>{},10000);
  process.on('SIGINT',()=>{
    fs.writeSync(2,'idle-handled\\n');
    clearInterval(keepAlive);setImmediate(()=>process.exit(23));
  });
  fs.writeSync(2,'ready\\n');`;
