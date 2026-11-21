import { Memory, Resource, ResourceManager, WasmContext } from "@vscode/wasm-component-model";
import { guest, type Window } from "experiment-wit-bindings";
import { readSurfaceInfo } from "../../packages/waffle/browser/display/surface-info.js";
import type { WorkerSetupContext } from "../../packages/waffle/browser/worker.js";
import {
  atomicsLoad,
  Int32ArrayConstructor,
  wasmMemoryBuffer,
} from "../../packages/waffle/proc/intrinsics.js";

const namespace = "waffle:experiment/window";

export function create(context: Pick<WorkerSetupContext, "checkActive" | "request">) {
  const {
    checkActive,
    request: { graphics },
  } = context;
  const surface = graphics?.surfaces[0];
  if (!surface || graphics.gpu || graphics.surfaces.length !== 1)
    throw new Error("The experiment requires one surface-only grant");

  const revocation = new Int32ArrayConstructor(graphics.revocation);
  const info = new Int32ArrayConstructor(surface.info);
  const snapshot = new DataView(new ArrayBuffer(16));
  const manager = new ResourceManager.Default<Surface>();
  let permitted = false;
  let current: Surface | undefined;
  let drops = 0;

  class Surface extends Resource.Default implements Window.Surface {
    static readonly $manager = manager;
    sample: Window.SurfaceInfo | undefined;

    info(): Window.SurfaceInfo | undefined {
      return this.sample;
    }

    $drop(): void {
      drops++;
    }
  }

  const wasm = new WasmContext.Default();
  const { [namespace]: generated } = guest._.imports.create(
    {
      window: {
        Surface,
        acquire() {
          if (!permitted || current) return undefined;
          current = new Surface(manager);
          return current;
        },
      },
    },
    wasm,
  );

  return {
    imports: {
      [namespace]: {
        acquire(id: number, out: number) {
          checkActive();
          permitted = id >>> 0 === surface.id && atomicsLoad(revocation, 0) === 0;
          generated.acquire(id, out);
        },
        "[method]surface.info"(handle: number, out: number) {
          checkActive();
          if (current?.$handle() === handle) {
            const live = atomicsLoad(revocation, 0) === 0;
            current.sample =
              live && readSurfaceInfo(info, snapshot) === 0
                ? {
                    width: snapshot.getUint32(0, true),
                    height: snapshot.getUint32(4, true),
                    scaleMilli: snapshot.getUint32(8, true),
                    flags: snapshot.getUint32(12, true),
                  }
                : undefined;
          }
          generated["[method]surface.info"](handle, out);
        },
        "[resource-drop]surface"(handle: number) {
          checkActive();
          generated["[resource-drop]surface"](handle);
          current = undefined;
        },
      },
    },
    bind(instance: WebAssembly.Instance) {
      const { memory, cabi_realloc } = instance.exports;
      if (!(memory instanceof WebAssembly.Memory) || typeof cabi_realloc !== "function")
        throw new Error("Missing canonical ABI memory exports");
      wasm.initialize(
        new Memory.Default(
          {
            memory: {
              get buffer() {
                return wasmMemoryBuffer(memory);
              },
            },
            cabi_realloc,
          },
          "surface",
        ),
      );
    },
    retire() {
      const handle = current?.$handle();
      if (handle !== undefined) manager.removeResource(handle);
      current = undefined;
      return {
        outstanding: Number(handle !== undefined),
        remaining: Number(handle !== undefined && manager.hasResource(handle)),
        drops,
      };
    },
  };
}
