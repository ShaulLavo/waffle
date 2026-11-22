import {
  bootstrap,
  preview1Executor,
  type RuntimeWorkerRequest,
} from "../../packages/waffle/browser/worker.js";

const moduleName = "waffle:experiment/window";
const adapterURL = "/wit-surface-adapter.js";
const send = globalThis.postMessage.bind(globalThis);

globalThis.addEventListener("message", async ({ data }: MessageEvent<RuntimeWorkerRequest>) => {
  if (!WebAssembly.Module.imports(data.module).some((item) => item.module === moduleName)) {
    await bootstrap(data, preview1Executor);
    return;
  }

  let adapter: typeof import("./adapter.js") | undefined;
  let loadError: unknown;
  try {
    adapter = await import(adapterURL);
    send({ surfaceExperiment: "evaluated" });
  } catch (error) {
    loadError = error;
    send({ surfaceExperiment: String(error) });
  }

  let binding: ReturnType<(typeof import("./adapter.js"))["create"]> | undefined;
  await bootstrap(data, {
    ...preview1Executor,
    namespaces(context) {
      if (!adapter) throw loadError;
      binding = adapter.create(context);
      return binding.imports;
    },
    initialize({ instance }) {
      binding!.bind(instance);
    },
    beforeFinish() {
      if (binding) send({ surfaceExperiment: binding.retire() });
    },
  });
});
