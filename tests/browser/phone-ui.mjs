import assert from "node:assert/strict";

const widths = [320, 375, 393, 430];

async function fits(page, label) {
  await page.waitForTimeout(60);
  const size = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
  assert.ok(size.scroll <= size.width, `${label}: page width ${size.scroll} exceeds viewport ${size.width}`);
  // A clipped header also passes scrollWidth, so check the controls themselves.
  for (const selector of ["header h1", "header a.nav", "#engine", "#run, #restart", "#copy-terminal"]) {
    const box = await page.locator(selector).boundingBox();
    assert.ok(box && box.width > 0 && box.x >= 0 && box.x + box.width <= size.width, `${label}: ${selector} outside viewport`);
  }
  await page.evaluate(() => window.scrollTo(500, 0));
  assert.equal(await page.evaluate(() => scrollX), 0, `${label}: page pans sideways`);
}

async function flushTerminal(page, app) {
  await page.evaluate((app) => new Promise((resolve) => globalThis[app].term.write("", resolve)), app);
}

async function copyOutput(page, app, chromium, expected) {
  await flushTerminal(page, app);
  // The expected full buffer comes from xterm's own selection API, independently of the copy helper.
  const buffer = await page.evaluate((app) => {
    const { term } = globalThis[app];
    term.selectAll();
    const text = term.getSelection().trimEnd();
    term.clearSelection();
    return text;
  }, app);
  await page.getByRole("button", { name: "Copy", exact: true }).click();
  await page.getByRole("button", { name: "Copied", exact: true }).waitFor();
  if (chromium) {
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    assert.equal(copied, buffer, `${app}: full terminal buffer copied without display wraps or ANSI escapes`);
    assert.ok(copied.includes(expected), `${app}: long output missing from clipboard`);
  }
  // Wait for the button to reset before the next width.
  await page.getByRole("button", { name: "Copy", exact: true }).waitFor();
}

async function printSandboxOutput(page, long) {
  await page.evaluate((long) => {
    const { fs, restart } = globalThis.sandbox;
    const path = "/home/user/app/dev.ts";
    const source = new TextDecoder().decode(fs.readFile(path));
    fs.writeFile(path, `console.log("${long}");\n` + source);
    void restart();
  }, long);
  await page.waitForFunction((long) => {
    const { term } = globalThis.sandbox;
    term.selectAll();
    const text = term.getSelection();
    term.clearSelection();
    return text.includes(long) && globalThis.sandbox.server();
  }, long, { timeout: 180_000 });
}

async function openLongFile(page, app, path, long) {
  await page.evaluate(([app, path, long]) => {
    const ui = globalThis[app];
    ui.fs.writeFile(`${app === "playground" ? "/home/user" : "/home/user/app"}/${path}`, `// ${long}`);
    if (app === "sandbox" && !document.querySelector(`#file-select option[value="${path}"]`)) {
      document.querySelector("#file-select").add(new Option(path, path));
    }
    ui.editor.open(app === "playground" ? `/home/user/${path}` : path);
  }, [app, path, long]);
}

async function widenPreview(page) {
  const scroll = await page.evaluate(() => {
    const frame = document.querySelector("#preview");
    const doc = frame.contentDocument;
    const wide = doc.createElement("div");
    wide.style.width = "4000px";
    wide.textContent = "wide preview";
    doc.body.append(wide);
    frame.contentWindow.scrollTo(3000, 0);
    return doc.documentElement.scrollWidth;
  });
  assert.ok(scroll >= 4000, "sandbox: preview contains overflowing content");
}

async function checkWidth(page, app, chromium, files, long, path, width) {
  await page.setViewportSize({ width, height: 850 });
  await fits(page, `${app}/${width}/initial`);
  for (const file of files) {
    await page.evaluate(([app, file]) => globalThis[app].editor.open(file), [app, file]);
    await fits(page, `${app}/${width}/${file}`);
  }
  await openLongFile(page, app, path, long);
  if (app === "playground") {
    await page.evaluate((long) => globalThis.playground.shell.submit(`bun -e 'console.log("${long}")'`), long);
  } else {
    await widenPreview(page);
  }
  await flushTerminal(page, app);
  await fits(page, `${app}/${width}/long output and file`);
  await copyOutput(page, app, chromium, long);
  // Short viewports cover keyboard-sized layouts; actual keyboard checked on the simulator.
  await page.locator(".cm-content").focus();
  await page.setViewportSize({ width, height: 360 });
  await fits(page, `${app}/${width}/keyboard`);
  await page.setViewportSize({ width: 850, height: width });
  await fits(page, `${app}/${width}/landscape`);
  await page.setViewportSize({ width: 850, height: 240 });
  await fits(page, `${app}/${width}/landscape keyboard`);
}

/** Runs in both the engine smoke tests and the sandbox HMR checklist. */
export async function checkPhoneUI(page, app, chromium) {
  const previous = page.viewportSize();
  if (chromium) await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const files = await page.evaluate((app) => app === "playground"
    ? globalThis.playground.fs.listFiles("/home/user")
    : Array.from(document.querySelector("#file-select").options, (option) => option.value), app);
  const long = "phone-copy-" + "0123456789".repeat(120);
  const path = "a-very-long-file-name-" + "abcdef".repeat(40) + ".ts";
  try {
    if (app === "sandbox") await printSandboxOutput(page, long);
    for (const width of widths) await checkWidth(page, app, chromium, files, long, path, width);
  } finally {
    if (previous) await page.setViewportSize(previous);
  }
}
