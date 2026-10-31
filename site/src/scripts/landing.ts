// Scroll story for the landing page. The page scrolls natively; this file turns the scroll
// position into one progress value for the 3D scene and keeps the scene framed in the free
// part of the screen. It never sets layout styles, so the URL bar showing or hiding on a
// phone cannot make the page jump.

interface SceneRegion {
  cx: number;
  cy: number;
  wf: number;
  hf: number;
}

interface SceneOptions {
  progress: number;
  layout: SceneRegion;
  compact: boolean;
  reducedMotion: boolean;
  background: boolean;
  labels: boolean;
  adaptive: boolean;
  onReady: () => void;
  onProgress: (progress: number) => void;
}

interface WaffleSceneInstance {
  setProgress(progress: number, immediate?: boolean): void;
  setLayout(layout: SceneRegion): void;
  setReducedMotion(reduced: boolean): void;
  destroy(): void;
}

declare global {
  interface Window {
    WaffleScene?: {
      mount(canvas: HTMLCanvasElement, options: SceneOptions): WaffleSceneInstance | null;
    };
  }
}

/** A scroll offset inside the story and the scene progress that belongs there. */
interface Anchor {
  offset: number;
  progress: number;
}

const COMPACT = "(max-width: 859px)";
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Piecewise-linear lookup over anchors sorted by offset. */
function progressAt(anchors: readonly Anchor[], offset: number): number {
  const first = anchors[0];
  if (!first || offset <= first.offset) return first?.progress ?? 0;
  for (let index = 1; index < anchors.length; index++) {
    const next = anchors[index];
    const previous = anchors[index - 1];
    if (!next || !previous || offset > next.offset) continue;
    const span = next.offset - previous.offset;
    const t = span > 0 ? (offset - previous.offset) / span : 1;
    return previous.progress + (next.progress - previous.progress) * t;
  }
  return anchors.at(-1)?.progress ?? 1;
}

function mixHex(from: string, to: string, t: number): string {
  const channel = (hex: string, index: number) =>
    Number.parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16);
  const k = Math.min(1, Math.max(0, t));
  let out = "#";
  for (let index = 0; index < 3; index++) {
    const value = Math.round(
      channel(from, index) + (channel(to, index) - channel(from, index)) * k,
    );
    out += value.toString(16).padStart(2, "0");
  }
  return out;
}

const BLUEPRINT = "#2350c7";
const SKY = "#86ccff";

/** A stretch of the page and the colour at its top and bottom edges. */
interface Band {
  top: number;
  bottom: number;
  from: string;
  to: string;
}

/**
 * Keeps the browser's own bars the colour of whatever sits under the top of the viewport.
 * Chrome and older Safari read `theme-color`. Safari 26 ignores it and paints its top bar with
 * the body's background colour (checked in the iOS 26.5 simulator), so the body follows too.
 * The sections all paint their own backgrounds, so the body colour only shows in the bars and
 * in overscroll. Nothing is written unless the colour changes.
 */
class BrowserTint {
  private readonly meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  private bands: Band[] = [];
  private storyBottom = 0;
  private current = "";

  measure(story: HTMLElement) {
    const scroll = window.scrollY;
    const box = (element: Element) => element.getBoundingClientRect();
    this.storyBottom = box(story).bottom + scroll;
    this.bands = Array.from(document.querySelectorAll<HTMLElement>("[data-tint]"), (element) => {
      const rect = box(element);
      const [from = "#ffffff", to = from] = (element.dataset.tint ?? "").split(" ");
      return { top: rect.top + scroll, bottom: rect.bottom + scroll, from, to };
    });
  }

  /** The colour under document position `y`; inside the story, the top of the stage. */
  private colorAt(y: number, stageColor: string): string {
    if (y < this.storyBottom) return stageColor;
    const band = this.bands.find((item) => y >= item.top && y < item.bottom) ?? this.bands.at(-1);
    if (!band) return stageColor;
    return mixHex(band.from, band.to, (y - band.top) / Math.max(1, band.bottom - band.top));
  }

  update(storyProgress: number) {
    const color = this.colorAt(
      window.scrollY,
      mixHex(BLUEPRINT, SKY, smoothstep(0.5, 0.78, storyProgress)),
    );
    if (color === this.current) return;
    this.current = color;
    this.meta?.setAttribute("content", color);
    document.documentElement.style.backgroundColor = color;
    document.body.style.backgroundColor = color;
  }
}

/** Snap to the nearest anchor, so reduced motion gets still frames instead of a camera fly. */
function nearestAnchor(anchors: readonly Anchor[], offset: number): number {
  let best = anchors[0];
  for (const anchor of anchors) {
    if (best && Math.abs(anchor.offset - offset) < Math.abs(best.offset - offset)) best = anchor;
  }
  return best?.progress ?? 0;
}

class Story {
  private readonly stage: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly blueprint: HTMLElement;
  private readonly heroCopy: HTMLElement | null;
  private readonly deck: HTMLElement | null;
  private readonly cards: HTMLElement[];
  private readonly probe: HTMLElement;
  private readonly compact = window.matchMedia(COMPACT);
  private readonly reduced = window.matchMedia(REDUCED_MOTION);
  private readonly resizeObserver: ResizeObserver;
  private anchors: Anchor[] = [];
  private top = 0;
  private progress = 0;
  private frame = 0;
  private measureFrame = 0;
  private inHero = true;
  private scene: WaffleSceneInstance | null = null;
  private sceneProgress = 0;
  private readonly tint = new BrowserTint();
  private alive = true;

  constructor(private readonly root: HTMLElement) {
    this.stage = this.require("[data-stage]");
    this.canvas = this.require<HTMLCanvasElement>("[data-scene]");
    this.blueprint = this.require("[data-blueprint]");
    this.probe = this.require("[data-svh]");
    this.heroCopy = root.querySelector("[data-hero-copy]");
    this.deck = root.querySelector("[data-deck]");
    this.cards = Array.from(root.querySelectorAll<HTMLElement>("[data-progress]"));
    // Measuring resizes the deck, so wait a frame instead of measuring inside the observer.
    this.resizeObserver = new ResizeObserver(this.scheduleMeasure);
    this.resizeObserver.observe(root);
    this.resizeObserver.observe(this.stage);
    // The hero copy changes height when the web fonts arrive, which moves the phone framing.
    if (this.heroCopy) this.resizeObserver.observe(this.heroCopy);
    window.addEventListener("scroll", this.onScroll, { passive: true });
    this.compact.addEventListener("change", this.scheduleMeasure);
    this.reduced.addEventListener("change", this.scheduleMeasure);
    this.reduced.addEventListener("change", this.onReducedChange);
    this.measure();
  }

  private require<T extends Element = HTMLElement>(selector: string): T {
    const element = this.root.querySelector<T>(selector);
    if (!element) throw new Error(`Landing story is missing ${selector}`);
    return element;
  }

  destroy() {
    this.alive = false;
    window.removeEventListener("scroll", this.onScroll);
    this.compact.removeEventListener("change", this.scheduleMeasure);
    this.reduced.removeEventListener("change", this.scheduleMeasure);
    this.reduced.removeEventListener("change", this.onReducedChange);
    this.resizeObserver.disconnect();
    if (this.frame) cancelAnimationFrame(this.frame);
    if (this.measureFrame) cancelAnimationFrame(this.measureFrame);
    this.scene?.destroy();
    this.scene = null;
  }

  private onScroll = () => {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.update();
    });
  };

  private onReducedChange = () => {
    this.scene?.setReducedMotion(this.reduced.matches);
  };

  private scheduleMeasure = () => {
    if (this.measureFrame) return;
    this.measureFrame = requestAnimationFrame(() => {
      this.measureFrame = 0;
      this.measure();
    });
  };

  /** Read layout once per resize. Scroll frames only do arithmetic on these numbers. */
  private measure() {
    this.sizeDeck();
    const viewport = this.probe.offsetHeight || window.innerHeight;
    const rootTop = this.root.getBoundingClientRect().top;
    this.top = rootTop + window.scrollY;
    const end = Math.max(1, this.root.offsetHeight - viewport);
    const anchors: Anchor[] = [{ offset: 0, progress: 0 }];
    for (const card of this.cards) {
      const progress = Number(card.dataset.progress);
      const spacer = card.previousElementSibling;
      if (!Number.isFinite(progress) || !spacer) continue;
      // A docked card reports its stuck position, so read where it sits in the flow from the
      // spacer before it. The card docks once that point has scrolled up to its sticky top.
      const flowTop = spacer.getBoundingClientRect().bottom - rootTop;
      const dockTop = Number.parseFloat(getComputedStyle(card).top) || 0;
      anchors.push({ offset: Math.min(end, Math.max(0, flowTop - dockTop)), progress });
    }
    anchors.push({ offset: end, progress: 1 });
    this.anchors = anchors.sort((a, b) => a.offset - b.offset);
    this.tint.measure(this.root);
    this.update(true);
  }

  /** Give every card the height of the tallest, so a docked card fully covers the last one. */
  private sizeDeck() {
    if (!this.deck || this.cards.length === 0) return;
    // Collapse the shared height first so each card reports its natural height.
    this.deck.style.setProperty("--dock-h", "0px");
    const tallest = Math.ceil(Math.max(...this.cards.map((card) => card.offsetHeight)));
    this.deck.style.setProperty("--dock-h", `${tallest}px`);
  }

  private update(force = false) {
    this.tint.update(this.scene ? this.sceneProgress : this.progress);
    const offset = window.scrollY - this.top;
    const progress = this.reduced.matches
      ? nearestAnchor(this.anchors, offset)
      : progressAt(this.anchors, offset);
    const inHero = progress < 0.04;
    if (force || inHero !== this.inHero) {
      this.inHero = inHero;
      this.scene?.setLayout(this.region());
    }
    if (!force && Math.abs(progress - this.progress) < 0.0005) return;
    this.progress = progress;
    if (this.scene) this.scene.setProgress(progress, this.reduced.matches);
    else this.paintSky(progress);
  }

  /** The blueprint layer fades out as the waffle meets the sky, in step with the scene. */
  private paintSky = (progress: number) => {
    this.sceneProgress = progress;
    this.blueprint.style.opacity = String(1 - smoothstep(0.5, 0.78, progress));
    this.tint.update(progress);
  };

  /** Where the waffle sits, as fractions of the canvas. */
  private region(): SceneRegion {
    const width = this.stage.clientWidth || window.innerWidth;
    const height = this.stage.clientHeight || window.innerHeight;
    const visible = Math.min(height, this.probe.offsetHeight || height);
    // Bottom edge of the floating nav bar, with a little air.
    const nav = 76;
    if (!this.compact.matches) {
      const copy = this.heroCopy?.getBoundingClientRect();
      const left = Math.min(width * 0.5, (copy?.right ?? width * 0.42) + 24);
      const right = width - Math.max(24, width * 0.04);
      const top = nav;
      // Half-folded, the waffle is wider than its fit radius suggests, so keep some margin.
      return {
        cx: (left + right) / 2 / width,
        cy: (top + visible) / 2 / height,
        wf: ((right - left) * 0.9) / width,
        hf: ((visible - top) * 0.9) / height,
      };
    }
    // Phones: under the hero copy at first, then centred above the docked step cards. The copy's
    // bottom is measured from the top of the story, which is where the stage sits at scroll zero,
    // so coming back up mid-scroll still frames the waffle under the copy, not under the logo.
    const copyBottom = this.heroCopy
      ? this.heroCopy.getBoundingClientRect().bottom - this.root.getBoundingClientRect().top
      : visible * 0.5;
    const top = this.inHero ? Math.min(visible * 0.62, copyBottom + 8) : nav;
    // Leave room for a docked step card, about 260px, but never squeeze the waffle below 55%.
    const bottom = this.inHero ? visible - 8 : Math.max(visible * 0.55, visible - 270);
    // The finished waffle sits at an angle and reaches further right than left, so nudge it left.
    return {
      cx: this.inHero ? 0.5 : 0.47,
      cy: (top + bottom) / 2 / height,
      wf: Math.min(0.8, 480 / width),
      hf: (bottom - top) / height,
    };
  }

  mountScene() {
    if (!this.alive || this.scene) return;
    const api = window.WaffleScene;
    const scene = api?.mount(this.canvas, {
      progress: this.progress,
      layout: this.region(),
      compact: this.compact.matches,
      reducedMotion: this.reduced.matches,
      background: false,
      labels: true,
      adaptive: !new URLSearchParams(location.search).has("full-quality"),
      onReady: () => {
        this.canvas.dataset.ready = "";
      },
      onProgress: this.paintSky,
    });
    if (!scene) {
      this.sceneFailed();
      return;
    }
    this.scene = scene;
    this.update(true);
  }

  sceneFailed() {
    if (!this.alive) return;
    this.root.dataset.noGl = "";
  }
}

export function initializeLanding() {
  const root = document.querySelector<HTMLElement>("[data-story]");
  if (!root) return () => {};
  const story = new Story(root);
  let alive = true;
  let idle = 0;
  const destroy = () => {
    alive = false;
    if (idle) cancelIdle(idle);
    story.destroy();
    window.removeEventListener("pagehide", onPageHide);
  };
  const onPageHide = (event: PageTransitionEvent) => {
    // A bfcache entry is suspended by the browser and resumes its existing scene.
    if (!event.persisted) destroy();
  };
  window.addEventListener("pagehide", onPageHide);
  // Text and layout paint first; three.js loads once the main thread has a moment.
  idle = requestIdle(() => {
    idle = 0;
    if (!alive) return;
    void import("./waffle-scene")
      .then(() => {
        if (alive) story.mountScene();
      })
      .catch(() => {
        if (alive) story.sceneFailed();
      });
  });
  return destroy;
}

// Safari has no idle callbacks, so fall back to a short timeout there.
const idleScheduler: Partial<Pick<Window, "requestIdleCallback" | "cancelIdleCallback">> = window;

function requestIdle(callback: () => void): number {
  if (idleScheduler.requestIdleCallback) {
    return idleScheduler.requestIdleCallback(callback, { timeout: 600 });
  }
  return window.setTimeout(callback, 120);
}

function cancelIdle(handle: number) {
  if (idleScheduler.cancelIdleCallback) idleScheduler.cancelIdleCallback(handle);
  else window.clearTimeout(handle);
}
