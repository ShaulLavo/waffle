export interface LandingState {
  p: number;
  scroll: boolean;
  vh: number;
  narrow: boolean;
  noGl: boolean;
  canvasO: number;
  past?: boolean;
}

export const initialState: LandingState = {
  p: 0, scroll: false, vh: 900, narrow: false, noGl: false, canvasO: 1,
};

export function renderValues(state: LandingState) {
    const p = state.p;
    const narrow = state.narrow;
    const scroll = state.scroll;
    const vh = Math.max(560, state.vh);
    const stageH = scroll ? vh : 900;
    const scrollyH = scroll ? Math.round(vh * 4.4) : 900;
    const sst = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    const beat = (a: number, b: number) => {
      const f = 0.045;
      const inn = a <= 0 ? 1 : sst(a - f, a, p);
      const out = b >= 1 ? 0 : sst(b - f, b, p);
      const o = inn * (1 - out);
      const y = (1 - inn) * 30 - out * 30;
      return 'opacity:' + o.toFixed(3) + ';transform:translate3d(0,' + y.toFixed(1) + 'px,0);pointer-events:' + (o > 0.5 ? 'auto' : 'none') + ';visibility:' + (o < 0.01 ? 'hidden' : 'visible');
    };
    const mix = (a: string, b: string, t: number) => {
      const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
      const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
      return 'rgb(' + pa.map((v, i) => Math.round(v + (pb[i] - v) * t)).join(',') + ')';
    };
    const back = (t: number) => { if (t <= 0) return 0; if (t >= 1) return 1; const c1 = 1.9, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };
    const word = 'waffle'.split('');
    const letters = word.map((ch, i) => {
      const k = back(Math.min(1, Math.max(0, (p - 0.86 - i * 0.014) / 0.05)));
      const rot = (i % 2 ? 1 : -1) * (1 - k) * 12;
      return { ch, style: 'transform:translateY(' + ((1 - k) * 70).toFixed(1) + 'px) rotate(' + rot.toFixed(1) + 'deg) scale(' + Math.max(0.001, k).toFixed(3) + ');transform-origin:50% 100%' };
    });
    const panelH = narrow ? Math.round(Math.min(430, Math.max(350, vh * 0.5))) : 0;
    const canvasTop = narrow ? panelH - 40 : 0;
    const tilt = Math.round(88.5 - 42.5 * sst(0.06, 0.62, p));
    const ridges = (0.72 * sst(0.2, 0.6, p)).toFixed(2);
    const seated = p < 0.4 ? 0 : Math.min(11, Math.round(sst(0.4, 0.66, p) * 11));
    return {
      wide: !narrow,
      stageFade: (() => { const c = mix('#2350C7', '#F4F6FC', sst(0.5, 0.78, p)).slice(4, -1); return 'linear-gradient(180deg, rgba(' + c + ',0) 0%, rgba(' + c + ',1) 100%)'; })(),
      logoStyle: '',
      navStyle: (scroll && p > 0.86) ? 'opacity: 0; transform: translateY(-28px); visibility: hidden; pointer-events: none' : 'opacity: 1; transform: none; visibility: visible',
      scroll,
      noGl: state.noGl,
      stageH,
      scrollyH,
      stageBg: 'linear-gradient(180deg,' + mix('#2350C7', '#86CCFF', sst(0.5, 0.78, p)) + ',' + mix('#2350C7', '#F4F6FC', sst(0.5, 0.78, p)) + ')',
      canvasO: (state.canvasO ?? 1).toFixed(3),
      narrow,
      scrollCue: scroll && !narrow,
      leadTail: narrow ? 'none' : 'inline',
      btnFlex: narrow ? '1 1 0' : '0 0 auto',
      btnPad: narrow ? '12px' : '24px',
      arrowD: narrow ? 'none' : 'inline',
      cardPad: narrow ? '20px 22px' : '26px 28px',
      cardBody: narrow ? '16px' : '17px',
      canvasTop: canvasTop,
      canvasH: narrow ? 'calc(100% - ' + canvasTop + 'px)' : '100%',
      canvasMask: narrow ? 'linear-gradient(180deg, transparent 0, #000 70px)' : 'none',
      h1Size: narrow ? (vh < 720 ? '31px' : '36px') : 'clamp(42px, 5.4vw, 90px)',
      leadSize: narrow ? '16px' : 'clamp(17px, 1.35vw, 20px)',
      b0Gap: narrow ? '12px' : '22px',
      beatBox: narrow ? 'left: 18px; right: 18px; top: 78px; height: ' + (panelH - 88) + 'px' : 'left: clamp(24px, 5vw, 88px); top: 0; bottom: 0; width: min(600px, 44%)',
      beatAlign: narrow ? 'flex-start' : 'center',
      readoutBox: narrow ? 'left: 16px; bottom: 16px' : 'right: 28px; bottom: 26px',
      b0: beat(0, 0.13),
      b1: beat(0.17, 0.38),
      b2: beat(0.42, 0.62),
      b3: beat(0.66, 0.84),
      b4: beat(0.88, 1),
      letters,
      tilt,
      ridges,
      seated,
      pct: Math.round(p * 100),
      wheelY: (8 + 5 * ((Date.now() / 900) % 1)).toFixed(1)
    };
  }

export function interpolateStyle(template: string, values: ReturnType<typeof renderValues>): string {
  const entries = new Map(Object.entries(values));
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(entries.get(key) ?? ''));
}

type SceneLayout = 'phone' | { cx: number; cy: number; wf: number; hf: number };
interface WaffleSceneInstance {
  setProgress(progress: number, immediate?: boolean): void;
  setLayout(layout: SceneLayout): void;
  setLabels(labels: boolean): void;
  destroy(): void;
}

declare global {
  interface Window {
    WaffleScene?: {
      mount(canvas: HTMLCanvasElement, options: {
        progress: number;
        layout: SceneLayout;
        compact: boolean;
        background: boolean;
        labels: boolean;
      }): WaffleSceneInstance | null;
    };
  }
}

type HeroPreview = 'waffle' | 'grid' | 'loop';

class LandingController {
  private state: LandingState = { ...initialState };
  private scene: WaffleSceneInstance | null = null;
  private alive = true;
  private scrollFrame = 0;
  private posterFrame = 0;
  private readonly styles;
  private readonly conditions;
  private readonly letters;
  private readonly wheel;

  constructor(
    private readonly root: HTMLElement,
    private readonly preview: HeroPreview,
    private readonly labels: boolean,
  ) {
    this.styles = Array.from(root.querySelectorAll<HTMLElement | SVGElement>('[data-waffle-style]'),
      (element) => ({ element, template: element.getAttribute('data-waffle-style') ?? '' }));
    this.conditions = Array.from(root.querySelectorAll<HTMLElement>('[data-waffle-if]'));
    this.letters = Array.from(root.querySelectorAll<HTMLElement>('[data-waffle-letter]'));
    this.wheel = root.querySelector('[data-wheel-dot]');
    window.addEventListener('resize', this.onResize);
    document.addEventListener('scroll', this.onScroll, { passive: true, capture: true });
    this.measure();
  }

  destroy = () => {
    this.alive = false;
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('scroll', this.onScroll, { capture: true });
    if (this.scrollFrame) cancelAnimationFrame(this.scrollFrame);
    this.stopPoster();
    this.scene?.destroy();
    this.scene = null;
  };

  private render() {
    const values = renderValues(this.state);
    this.wheel?.setAttribute('cy', values.wheelY);
    for (const { element, template } of this.styles) {
      const style = interpolateStyle(template, values);
      if (element.getAttribute('style') !== style) element.setAttribute('style', style);
    }
    const conditions = new Map(Object.entries(values));
    for (const element of this.conditions) {
      element.hidden = !conditions.get(element.dataset.waffleIf ?? '');
    }
    for (const [index, element] of this.letters.entries()) {
      const letter = values.letters[index];
      if (letter) element.style.cssText = 'display: inline-block; ' + letter.style;
    }
  }

  private setState(update: Partial<LandingState>) {
    Object.assign(this.state, update);
    this.render();
  }

  private onResize = () => this.measure();

  private onScroll = () => {
    if (this.scrollFrame) return;
    this.scrollFrame = requestAnimationFrame(() => {
      this.scrollFrame = 0;
      this.readScroll();
    });
  };

  private measure() {
    const vh = window.innerHeight || 900;
    const vw = window.innerWidth || 1440;
    const scroll = vh < 1500;
    const narrow = vw < 860;
    this.setState({ vh, scroll, narrow });
    this.scene?.setLayout(this.sceneRegion());
    if (scroll) {
      this.stopPoster();
      this.readScroll();
    } else {
      this.startPoster();
    }
  }

  private sceneRegion(): SceneLayout {
    const vw = window.innerWidth || 1440;
    if (vw < 860) return 'phone';
    const pad = Math.min(88, Math.max(24, vw * 0.05));
    const left = pad + Math.min(600, vw * 0.44) + 28;
    const right = vw - 16;
    return { cx: (left + right) / 2 / vw, cy: 0.54, wf: (right - left) / vw, hf: 0.84 };
  }

  private readScroll() {
    if (!this.state.scroll) return;
    const element = this.root.querySelector('[data-scrolly]');
    if (!element) return;
    const r = element.getBoundingClientRect();
    const span = r.height - (window.innerHeight || 1);
    const p = span > 0 ? Math.min(1, Math.max(0, -r.top / span)) : 0;
    this.scene?.setProgress(p);
    const past = r.bottom < (window.innerHeight || 1) * 0.6;
    if (past !== !!this.state.past) this.setState({ past });
    if (Math.abs(p - this.state.p) > 0.001) this.setState({ p });
  }

  private posterMode(): HeroPreview {
    const mode = this.preview;
    let reduce = false;
    try {
      reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch { /* Media query support is optional. */ }
    return reduce && mode === 'loop' ? 'waffle' : mode;
  }

  private startPoster() {
    this.stopPoster();
    if (this.state.scroll) {
      if (this.state.canvasO !== 1) this.setState({ canvasO: 1 });
      return;
    }
    const mode = this.posterMode();
    if (mode !== 'loop') {
      const p = mode === 'grid' ? 0 : 1;
      this.scene?.setProgress(p, true);
      this.setState({ p, canvasO: 1 });
      return;
    }
    // Grid → waffle, hold, then a quick fade and a clean restart, never backwards.
    const t0 = performance.now();
    let last = 0, cutDone = -1;
    const tick = (now: number) => {
      if (!this.alive) return;
      this.posterFrame = requestAnimationFrame(tick);
      const tt = (now - t0) / 1000;
      const loop = Math.floor(tt / 14.5);
      const t = tt % 14.5;
      let p, o = 1;
      if (t < 2.5) p = 0;
      else if (t < 9) p = (t - 2.5) / 6.5;
      else if (t < 13.2) p = 1;
      else { p = 1; o = 1 - Math.min(1, (t - 13.2) / 0.5); }
      if (t >= 13.7 && cutDone !== loop) {
        cutDone = loop;
        this.scene?.setProgress(0, true);
      }
      if (t >= 13.7) { p = 0; o = Math.min(1, (t - 14.0) / 0.5); o = Math.max(0, o); }
      if (t < 0.01 && loop > 0) o = 0;
      if (this.scene && t < 13.7) this.scene.setProgress(p);
      if (now - last > 60) { last = now; this.setState({ p, canvasO: o }); }
    };
    this.posterFrame = requestAnimationFrame(tick);
  }

  private stopPoster() {
    if (this.posterFrame) cancelAnimationFrame(this.posterFrame);
    this.posterFrame = 0;
  }

  mountScene() {
    if (!this.alive || this.scene) return;
    const canvas = this.root.querySelector<HTMLCanvasElement>('[data-waffle-canvas]');
    if (!canvas || !window.WaffleScene) {
      this.sceneLoadFailed();
      return;
    }
    this.scene = window.WaffleScene.mount(canvas, {
      progress: this.state.p,
      layout: this.sceneRegion(),
      compact: (window.innerWidth || 1440) < 860,
      background: false,
      labels: this.labels,
    });
    if (!this.scene) { this.sceneLoadFailed(); return; }
    if (!this.state.scroll) this.startPoster();
    else this.readScroll();
  }

  sceneLoadFailed() {
    if (this.alive) this.setState({ noGl: true });
  }
}

export function initializeLanding() {
  const controllers = Array.from(document.querySelectorAll<HTMLElement>('[data-waffle-landing]'), (root) => {
    const value = root.dataset.heroPreview;
    const preview = value === 'loop' || value === 'grid' ? value : 'waffle';
    return new LandingController(root, preview, root.dataset.labels !== 'false');
  });
  let alive = true;
  let firstLoadFrame = 0;
  let secondLoadFrame = 0;
  const destroy = () => {
    alive = false;
    if (firstLoadFrame) cancelAnimationFrame(firstLoadFrame);
    if (secondLoadFrame) cancelAnimationFrame(secondLoadFrame);
    for (const controller of controllers) controller.destroy();
    window.removeEventListener('pagehide', onPageHide);
    document.removeEventListener('astro:before-swap', destroy);
  };
  const onPageHide = (event: PageTransitionEvent) => {
    // A bfcache entry is suspended by the browser and resumes its existing scene.
    if (!event.persisted) destroy();
  };
  window.addEventListener('pagehide', onPageHide);
  document.addEventListener('astro:before-swap', destroy, { once: true });
  // Keep text and layout on the first paint; mount whenever the deferred scene arrives.
  firstLoadFrame = requestAnimationFrame(() => {
    firstLoadFrame = 0;
    if (!alive) return;
    secondLoadFrame = requestAnimationFrame(() => {
      secondLoadFrame = 0;
      if (!alive) return;
      void import('./waffle-scene').then(() => {
        if (!alive) return;
        for (const controller of controllers) controller.mountScene();
      }).catch(() => {
        if (!alive) return;
        for (const controller of controllers) controller.sceneLoadFailed();
      });
    });
  });
  return destroy;
}
