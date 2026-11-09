import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "vite";

type WorkerGraph = { entry: string; dependents: string[] };

function captureWorkerGraph(graphs: WorkerGraph[]): Plugin {
  return {
    name: "capture-worker-entry-imports",
    generateBundle(_options, bundle) {
      const chunks = Object.values(bundle).filter((chunk) => chunk.type === "chunk");
      const entry = chunks.find((chunk) => chunk.isEntry);
      if (!entry) throw new Error("Expected a Worker entry");
      const graph: WorkerGraph = { entry: entry.fileName, dependents: [] };
      graphs.push(graph);
      for (const chunk of chunks) {
        if (!chunk.imports.concat(chunk.dynamicImports).includes(entry.fileName)) continue;
        graph.dependents.push(chunk.fileName);
      }
    },
  };
}

test("Preview 1 shared chunks never import the executable Worker entry", async () => {
  const graphs: WorkerGraph[] = [];
  await build({
    configFile: false,
    root: fileURLToPath(new URL("..", import.meta.url)),
    logLevel: "silent",
    worker: { format: "es", plugins: () => [captureWorkerGraph(graphs)] },
    build: {
      write: false,
      target: "esnext",
      rolldownOptions: {
        input: fileURLToPath(new URL("./fixtures/preview1-entry.ts", import.meta.url)),
      },
    },
  });
  // A Worker URL fragment must not create another copy of shared process classes.
  expect(graphs).toHaveLength(1);
  expect(graphs[0]!.dependents).toEqual([]);
}, 30_000);
