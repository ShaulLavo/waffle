import type { Dictionary } from "./lowering.js";
import type { SurfaceTarget } from "./replay.js";
import type { CompletionOwner } from "./completions.js";
import type { ServiceSurface } from "../display/service-protocol.js";
import { GpuCallError, GpuResourceError, type Handle } from "./protocol.js";

interface Frame {
  readonly texture: GPUTexture;
}
interface Presenter {
  readonly owner: SurfaceConnection;
  readonly reference: SurfaceReference;
  readonly device: GPUDevice;
  readonly canvas: OffscreenCanvas;
  readonly context: GPUCanvasContext;
  readonly configuration: GPUTextureDescriptor;
  frame: Frame | undefined;
  credit: boolean;
  readonly loss: { lost: boolean };
  cleanup: { readonly kind: "live" } | { readonly kind: "failed"; readonly error: unknown };
}
interface VisibleSurface {
  readonly canvas: OffscreenCanvas;
  readonly context: ImageBitmapRenderingContext;
  presenter: Presenter | undefined;
  retained: boolean;
}
interface SurfaceReference {
  readonly id: number;
  readonly handle: Handle;
  readonly visible: VisibleSurface;
}
type Attachment =
  | { readonly kind: "pending" }
  | { readonly kind: "attaching"; readonly canvas: OffscreenCanvas }
  | { readonly kind: "unavailable"; readonly canvas: OffscreenCanvas }
  | { readonly kind: "attached"; readonly visible: VisibleSurface }
  | { readonly kind: "cleaning"; readonly visible: VisibleSurface }
  | { readonly kind: "retained"; readonly visible: VisibleSurface; readonly error: unknown };
interface SurfaceEntry {
  phase: "live" | "disposing";
  attachment: Attachment;
}
/** Current page identities own native assets independently of their carrying grant. */
export class GpuSurfaces {
  readonly #entries = new Map<number, SurfaceEntry>();
  readonly #counts = { frameTexturesCreated: 0, presents: 0 };
  constructor(
    readonly suppressTransfer = false,
    private readonly accepting: () => boolean = () => true,
    private readonly wake: () => void = () => {},
  ) {}
  register(id: number): void {
    if (!Number.isInteger(id) || id < 1 || id > 0xffffffff)
      throw new GpuCallError("Invalid surface identity");
    if (!this.accepting() || this.#entries.has(id) || this.#entries.size >= 16)
      throw new GpuCallError("Duplicate or excessive surface");
    this.#entries.set(id, { phase: "live", attachment: { kind: "pending" } });
  }
  get(id: number): VisibleSurface | undefined {
    const entry = this.#entries.get(id);
    if (entry?.phase !== "live" || entry.attachment.kind !== "attached") return undefined;
    return entry.attachment.visible;
  }
  /** Native-resource inspection remains available during invalidation and failed cleanup. */
  resource(id: number): VisibleSurface | undefined {
    const attachment = this.#entries.get(id)?.attachment;
    if (!attachment || !("visible" in attachment)) return undefined;
    return attachment.visible;
  }
  attach(surfaces: readonly ServiceSurface[]): void {
    const failures: unknown[] = [];
    for (const surface of surfaces) {
      try {
        this.#attach(surface);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, "Surface attachment failed");
  }
  #attach(surface: ServiceSurface): void {
    if (surface.canvas === undefined) {
      if (!this.get(surface.id)) throw new GpuCallError("Unknown transferred surface");
      return;
    }
    const entry = this.#entries.get(surface.id);
    if (!entry || entry.phase !== "live" || !this.accepting())
      throw new GpuCallError("Unknown transferred surface");
    if (entry.attachment.kind !== "pending") throw new GpuCallError("Duplicate surface");
    const canvas = surface.canvas;
    entry.attachment = { kind: "attaching", canvas };
    try {
      this.#attachContext(entry, canvas);
    } finally {
      this.#finishAttachment(surface.id, entry);
    }
    if (!this.get(surface.id)) throw new GpuCallError("Surface unavailable");
  }
  #finishAttachment(id: number, entry: SurfaceEntry): void {
    if (entry.phase === "disposing" && this.#entries.get(id) === entry) this.invalidate(id);
    this.wake();
  }
  #attachContext(entry: SurfaceEntry, canvas: OffscreenCanvas): void {
    let context: ImageBitmapRenderingContext | null;
    try {
      context = canvas.getContext("bitmaprenderer");
      if (!context) throw new GpuCallError("Bitmap renderer unavailable");
    } catch (error) {
      entry.attachment = { kind: "unavailable", canvas };
      throw error;
    }
    entry.attachment = {
      kind: "attached",
      visible: { canvas, context, presenter: undefined, retained: false },
    };
    if (entry.phase === "live" && this.accepting()) return;
    entry.phase = "disposing";
    this.#cleanup(entry);
  }
  connection(ids: readonly number[], completions: CompletionOwner): SurfaceConnection {
    return new SurfaceConnection(this, ids, completions, this.suppressTransfer, this.#counts);
  }
  tick(): void {
    for (const id of this.#entries.keys()) {
      const presenter = this.get(id)?.presenter;
      if (!presenter || presenter.credit) continue;
      presenter.owner.completions.run(() => {
        presenter.credit = true;
        presenter.owner.completions.publish("frame-credit", 0, 0, {
          surface: { ...presenter.reference.handle },
        });
        return undefined;
      });
    }
  }
  invalidate(id: number): boolean {
    const entry = this.#entries.get(id);
    if (!entry) return false;
    entry.phase = "disposing";
    if (entry.attachment.kind === "pending" || entry.attachment.kind === "unavailable") {
      this.#entries.delete(id);
      return false;
    }
    return true;
  }
  invalidateAll(): void {
    for (const id of this.#entries.keys()) this.invalidate(id);
  }
  dispose(id: number): boolean {
    const entry = this.#entries.get(id);
    if (!entry) return true;
    entry.phase = "disposing";
    if (!this.#cleanup(entry)) return false;
    this.#entries.delete(id);
    return true;
  }
  #cleanup(entry: SurfaceEntry): boolean {
    const attachment = entry.attachment;
    if (attachment.kind === "attaching" || attachment.kind === "cleaning") return false;
    if (attachment.kind === "retained") throw attachment.error;
    if (attachment.kind !== "attached") return true;
    const visible = attachment.visible;
    entry.attachment = { kind: "cleaning", visible };
    try {
      dropPresenter(visible);
      visible.context.transferFromImageBitmap(null);
      visible.retained = false;
      entry.attachment = { kind: "pending" };
      return true;
    } catch (error) {
      entry.attachment = { kind: "retained", visible, error };
      throw error;
    }
  }
  disposeAll(): void {
    this.invalidateAll();
    for (const id of this.#entries.keys()) {
      try {
        this.dispose(id);
      } catch {
        // The entry retains the actual native resources and original cleanup error.
      }
    }
  }
  get active(): boolean {
    for (const entry of this.#entries.values())
      if (entry.attachment.kind === "attaching" || entry.attachment.kind === "cleaning")
        return true;
    return false;
  }
  get failures(): unknown[] {
    const failures: unknown[] = [];
    for (const entry of this.#entries.values())
      if (entry.attachment.kind === "retained") failures.push(entry.attachment.error);
    return failures;
  }
  snapshot() {
    const values = Array.from(this.#entries.keys(), (id) => this.resource(id)).filter(
      (visible) => visible !== undefined,
    );
    return {
      ...this.#counts,
      registeredSurfaces: this.#entries.size,
      surfaces: values.length,
      retainedBitmaps: values.filter((surface) => surface.retained).length,
      presentCanvasesLive: values.filter((surface) => surface.presenter).length,
      frameTexturesLive: values.filter((surface) => surface.presenter?.frame).length,
    };
  }
}
export class SurfaceConnection implements SurfaceTarget {
  readonly #references = new Set<SurfaceReference>();
  readonly #allowed: Set<number>;
  #live = true;
  readonly #sink: { owner: CompletionOwner | undefined };
  constructor(
    readonly surfaceOwner: GpuSurfaces,
    ids: readonly number[],
    readonly completions: CompletionOwner,
    readonly suppressTransfer: boolean,
    readonly counts: { frameTexturesCreated: number; presents: number },
  ) {
    this.#allowed = new Set(ids);
    this.#sink = { owner: completions };
  }
  create(id: number, _label: string, result: Handle): object {
    const visible = this.surfaceOwner.get(id);
    if (!this.#live || !this.#allowed.has(id) || !visible)
      throw new GpuCallError("Surface outside grant");
    const reference = { id, visible, handle: result };
    this.#references.add(reference);
    return reference;
  }
  configure(surface: object, descriptor: Dictionary): void {
    const reference = this.#reference(surface);
    const config = configuration(descriptor);
    const visible = reference.visible;
    const previous = visible.presenter;
    if (previous && previous.reference !== reference)
      previous.owner.completions.publish("surface-lost", 0, 0, {
        surface: { ...previous.reference.handle },
      });
    dropPresenter(visible);
    const canvas = new OffscreenCanvas(config.width, config.height);
    const context = canvas.getContext("webgpu");
    if (!(context instanceof GPUCanvasContext))
      throw new GpuCallError("Standalone WebGPU canvas unavailable");
    context.configure({
      device: config.device,
      format: config.format,
      alphaMode: config.alphaMode,
      usage: 2,
    });
    const texture: GPUTextureDescriptor = {
      size: [config.width, config.height],
      format: config.format,
      usage: config.usage | 1,
      viewFormats: config.viewFormats,
    };
    // Keep native validation in the guest's currently active scopes.
    config.device.createTexture(texture).destroy();
    if (visible.canvas.width !== config.width) visible.canvas.width = config.width;
    if (visible.canvas.height !== config.height) visible.canvas.height = config.height;
    const loss = { lost: false };
    const presenter: Presenter = {
      owner: this,
      reference,
      device: config.device,
      canvas,
      context,
      configuration: texture,
      frame: undefined,
      credit: true,
      loss,
      cleanup: { kind: "live" },
    };
    visible.presenter = presenter;
    void config.device.lost.then(() => {
      loss.lost = true;
    });
  }
  acquire(surface: object): ReturnType<SurfaceTarget["acquire"]> {
    const presenter = this.#presenter(surface);
    if (presenter.loss.lost) return { kind: "ready", texture: null, status: 6 };
    if (!presenter.credit) return { kind: "await" };
    if (!presenter.frame) {
      const texture = presenter.device.createTexture(presenter.configuration);
      this.counts.frameTexturesCreated++;
      presenter.frame = { texture };
    }
    return { kind: "ready", texture: presenter.frame.texture, status: 1 };
  }
  textureDestroyed(texture: object): void {
    for (const reference of this.#references) {
      const presenter = reference.visible.presenter;
      if (presenter?.owner === this && presenter.frame?.texture === texture)
        presenter.frame = undefined;
    }
  }
  present(surface: object): ReturnType<SurfaceTarget["present"]> {
    const reference = this.#reference(surface);
    const presenter = this.#presenter(surface);
    if (!presenter.credit) return { kind: "await" };
    if (!presenter.frame || presenter.loss.lost) throw new GpuCallError("No live frame");
    const frame = presenter.frame;
    presenter.frame = undefined;
    presenter.credit = false;
    this.counts.presents++;
    const device = presenter.device;
    device.pushErrorScope("validation");
    device.pushErrorScope("out-of-memory");
    device.pushErrorScope("internal");
    try {
      const encoder = device.createCommandEncoder();
      encoder.copyTextureToTexture(
        { texture: frame.texture },
        { texture: presenter.context.getCurrentTexture() },
        presenter.configuration.size,
      );
      device.queue.submit([encoder.finish()]);
      frame.texture.destroy();
      const bitmap = presenter.canvas.transferToImageBitmap();
      if (this.suppressTransfer) bitmap.close();
      else {
        reference.visible.context.transferFromImageBitmap(bitmap);
        reference.visible.retained = true;
      }
    } finally {
      frame.texture.destroy();
      // Pop synchronously, before the next guest record can manipulate its own scopes.
      const errors = [device.popErrorScope(), device.popErrorScope(), device.popErrorScope()];
      const sink = this.#sink,
        handle = reference.handle;
      void Promise.all(errors).then((errors) => presentErrors(sink.owner, handle, errors));
    }
    return { kind: "ready", status: 1 };
  }
  unconfigure(surface: object): void {
    const reference = this.#reference(surface);
    if (reference.visible.presenter?.reference === reference) dropPresenter(reference.visible);
  }
  release(surface: object): void {
    this.unconfigure(surface);
    this.#references.delete(this.#reference(surface));
  }
  stopPublishing(): void {
    this.#sink.owner = undefined;
  }
  dispose(): void {
    if (!this.#live) return;
    this.stopPublishing();
    this.#live = false;
    const failures: unknown[] = [];
    for (const reference of this.#references) {
      try {
        if (reference.visible.presenter?.owner === this) dropPresenter(reference.visible);
      } catch (error) {
        failures.push(error);
      }
    }
    this.#references.clear();
    if (failures.length) throw new AggregateError(failures, "GPU presenter cleanup failed");
  }
  #reference(surface: object): SurfaceReference {
    for (const reference of this.#references)
      if (reference === surface && this.#live) return reference;
    throw new GpuCallError("Unknown surface reference");
  }
  #presenter(surface: object): Presenter {
    const presenter = this.#reference(surface).visible.presenter;
    if (!presenter || presenter.reference !== this.#reference(surface))
      throw new GpuCallError("Surface not configured by connection");
    return presenter;
  }
}
function dropPresenter(visible: VisibleSurface): void {
  const presenter = visible.presenter;
  if (!presenter) return;
  if (presenter.cleanup.kind === "failed") throw presenter.cleanup.error;
  try {
    presenter.frame?.texture.destroy();
    presenter.frame = undefined;
    presenter.context.unconfigure();
    visible.presenter = undefined;
  } catch (error) {
    presenter.cleanup = { kind: "failed", error };
    throw error;
  }
}
function configuration(descriptor: Dictionary) {
  const { device, width, height, format, usage, alphaMode, viewFormats } = descriptor;
  if (
    !(device instanceof GPUDevice) ||
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 4096 ||
    height > 4096
  )
    throw new GpuCallError("Invalid or excessive surface dimensions");
  // Four logical images per surface, at most 256 MiB. Physical driver overhead is not promised.
  if (width * height * 8 * 4 > 256 * 1024 * 1024) throw new GpuResourceError("Surface image limit");
  if (format !== "bgra8unorm" && format !== "rgba8unorm" && format !== "rgba16float")
    throw new GpuCallError("Unsupported presentation format");
  if (typeof usage !== "number" || (alphaMode !== "opaque" && alphaMode !== "premultiplied"))
    throw new GpuCallError("Invalid surface configuration");
  if (!Array.isArray(viewFormats) || !viewFormats.every((value) => value === format))
    throw new GpuCallError("Unsupported view formats");
  const formats: GPUTextureFormat[] = viewFormats;
  return { device, width, height, format, usage, alphaMode, viewFormats: formats } satisfies {
    device: GPUDevice;
    width: number;
    height: number;
    format: GPUTextureFormat;
    usage: number;
    alphaMode: GPUCanvasAlphaMode;
    viewFormats: GPUTextureFormat[];
  };
}

function presentErrors(
  owner: CompletionOwner | undefined,
  handle: Handle,
  errors: readonly (GPUError | null)[],
): void {
  for (const error of errors)
    if (error)
      owner?.publish("present-failed", 0, -28, { surface: { ...handle }, message: error.message });
}
