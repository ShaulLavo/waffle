// The parts list: one highlight slides between rows, so two rows are never half lit at once.
// A mouse lights the row under it; keyboard focus lights the focused row. Touch does nothing.

export function startPartsList(): void {
  const bom = document.getElementById("bom");
  const highlight = bom?.querySelector<HTMLElement>(".bom__hl");
  if (!bom || !highlight) return;
  const rows = Array.from(bom.querySelectorAll("li"));
  let lit = false;

  const light = (row: HTMLLIElement) => {
    // Appear in place on entry; slide only when moving from one row to the next.
    if (!lit) highlight.style.transitionProperty = "opacity";
    highlight.style.height = `${row.offsetHeight}px`;
    highlight.style.transform = `translateY(${row.offsetTop}px)`;
    highlight.style.opacity = "1";
    if (!lit) {
      highlight.getBoundingClientRect();
      highlight.style.transitionProperty = "";
    }
    lit = true;
    for (const item of rows) item.classList.toggle("is-on", item === row);
  };

  const unlight = () => {
    lit = false;
    highlight.style.opacity = "0";
    for (const item of rows) item.classList.remove("is-on");
  };

  for (const row of rows) {
    row.addEventListener("pointerenter", (event) => {
      if (event.pointerType === "mouse") light(row);
    });
    row.addEventListener("focusin", () => light(row));
  }
  bom.addEventListener("pointerleave", unlight);
  bom.addEventListener("focusout", (event) => {
    if (!(event.relatedTarget instanceof Node) || !bom.contains(event.relatedTarget)) unlight();
  });
}
