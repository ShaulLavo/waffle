export interface ProcessTiming { mode: "cold" | "shared-module"; repetition: number; compileMs: number; firstOutputMs: number; exitMs: number; }
export async function measureProcessStarts(execute: (module: WebAssembly.Module, started: number) => Promise<{ firstOutputMs: number; exitMs: number }>) {
  const response = await fetch("/bun.wasm");
  if (!response.ok) throw new Error(`existing bun.wasm: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const wasmSha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
  const shared = await WebAssembly.compile(bytes);
  const rows: ProcessTiming[] = [];
  for (let repetition = 0; repetition < 5; repetition++) {
    for (const mode of ["cold", "shared-module"] as const) {
      const started = performance.now();
      let module = shared;
      if (mode === "cold") {
        // A unique valid custom section avoids byte-identical compiled-module caches. Fetch is
        // outside the interval; cold measures fresh compilation + startup, not network speed.
        const nonce = new TextEncoder().encode(crypto.randomUUID());
        const fresh = new Uint8Array(bytes.length + nonce.length + 3);
        fresh.set(bytes); fresh.set([0, nonce.length + 1, 0], bytes.length); fresh.set(nonce, bytes.length + 3);
        module = await WebAssembly.compile(fresh);
      }
      const compileMs = performance.now() - started;
      const sample = await execute(module, started);
      rows.push({ mode, repetition, compileMs, ...sample });
    }
  }
  const median = (values: number[]) => { values.sort((a, b) => a - b); return values[Math.floor(values.length / 2)]!; };
  return { wasmBytes: bytes.length, wasmSha256, repetitions: 5, method: "page-observed stdout via identical 1 ms SAB polling; network excluded; cold includes compile; no prestarted worker pool", rows,
    medians: Object.fromEntries((["cold", "shared-module"] as const).map(mode => { const samples = rows.filter(row => row.mode === mode); return [mode, { firstOutputMs: median(samples.map(row => row.firstOutputMs)), exitMs: median(samples.map(row => row.exitMs)), compileMs: median(samples.map(row => row.compileMs)) }]; })),
    pool: { enabled: false, reason: "optional worker pool not implemented or enabled" },
  };
}
