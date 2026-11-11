type KeyObservation = {
  type: string;
  target: string;
  key: string;
  code: string;
  location: number;
  repeat: boolean;
  trusted: boolean;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  prevented: boolean;
  start: number;
  end: number;
  value: string;
};
export type KeySnapshot = {
  focused: string;
  value: string;
  start: number;
  end: number;
  decoy: string;
  events: KeyObservation[];
};
export type KeyFixture = {
  setup(target: "primary" | "decoy", value: string, position: number, prevent: boolean): void;
  snapshot(): KeySnapshot;
  clear(): void;
  assertFocus(target: string): void;
  dispose(): void;
};
declare global {
  interface Window {
    __keyControl: KeyFixture;
  }
}
/** Fixture setup only. Native key edges are never synthesized here. */
export function installKeyControl(): KeyFixture {
  const primary = document.createElement("textarea");
  const decoy = document.createElement("textarea");
  primary.id = "primary";
  decoy.id = "decoy";
  primary.style.cssText = "font:16px monospace;width:600px;height:200px;white-space:pre";
  decoy.style.cssText = primary.style.cssText;
  document.body.append(primary, decoy);
  let prevent = false;
  let events: KeyObservation[] = [];
  const observe = (event: KeyboardEvent) => {
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement)) throw new Error("Unexpected key target");
    if (prevent && event.type === "keydown") event.preventDefault();
    events.push({
      type: event.type,
      target: target.id,
      key: event.key,
      code: event.code,
      location: event.location,
      repeat: event.repeat,
      trusted: event.isTrusted,
      alt: event.altKey,
      ctrl: event.ctrlKey,
      meta: event.metaKey,
      shift: event.shiftKey,
      prevented: event.defaultPrevented,
      start: target.selectionStart,
      end: target.selectionEnd,
      value: target.value,
    });
  };
  document.addEventListener("keydown", observe);
  document.addEventListener("keyup", observe);
  return {
    setup(target, value, position, preventDefault) {
      events = [];
      prevent = preventDefault;
      primary.value = target === "primary" ? value : "untouched-primary";
      decoy.value = target === "decoy" ? value : "untouched-decoy";
      const element = target === "primary" ? primary : decoy;
      element.focus();
      element.setSelectionRange(position, position);
    },
    clear() {
      events = [];
    },
    snapshot() {
      const element = document.activeElement;
      if (!(element instanceof HTMLTextAreaElement) || (element !== primary && element !== decoy))
        throw new Error("Fixture lost focus");
      return {
        focused: element.id,
        value: element.value,
        start: element.selectionStart,
        end: element.selectionEnd,
        decoy: element === primary ? decoy.value : primary.value,
        events: events.slice(),
      };
    },
    assertFocus(target) {
      if (document.activeElement?.id !== target) throw new Error("Wrong focused key target");
    },
    dispose() {
      document.removeEventListener("keydown", observe);
      document.removeEventListener("keyup", observe);
      primary.remove();
      decoy.remove();
    },
  };
}
