# Windows, input and a winit backend for guests

Status: **Proposed plan. Nothing here is implemented.** Rust crates live outside this repository
([where the code lives](guest-graphics.md#where-the-code-lives)).

Prepared: 2026-10-31. Inspected Waffle baseline
[`9b66e3aa2462771f65ca263745a23c80e2c8fea3`](https://github.com/ShaulLavo/waffle/commit/9b66e3aa2462771f65ca263745a23c80e2c8fea3),
winit `0.30.13` from crates.io, and Horizon
[`4e833c2fe6cfec9698cff687ded95208e8871061`](https://github.com/horizon-rust/horizon/commit/4e833c2fe6cfec9698cff687ded95208e8871061)
as the first consumer. Estimates are engineering judgments; nothing has been measured.

Part of the [guest graphics](guest-graphics.md) family, alongside the [WebGPU bridge](gpu-bridge.md)
and the [wgpu backend](wgpu-backend.md).

## Goal and supported boundary

Let a WASI Preview 1 guest own a window: a page `<canvas>` it draws into, the keyboard, mouse,
wheel, focus, resize and pointer-lock input aimed at it, and the window operations a desktop app
expects (title, cursor, grab, fullscreen, IME, clipboard). Expose that to Rust through an
unmodified winit 0.30 API, so an app that already runs `EventLoop::run_app` builds for
`wasm32-wasip1` or `wasm32-wasip1-threads` with a `[patch.crates-io]` line and no source changes
to its event handling.

The page owns every canvas. A guest borrows a **surface grant** for one canvas, exactly as it
borrows descriptors: it never sees the DOM, and the grant is revoked with its process.

Out of scope here: drawing (the [WebGPU bridge](gpu-bridge.md) owns the OffscreenCanvas), audio,
multiple browser windows (`window.open`), native menus, system tray, drag-out, and winit 0.31.

## Recommended decisions

| Area            | Decision                                                                                                                                                            | Reason / cost                                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page capability | `await runtime.display()`, lazy like `runtime.network()`. `display.createSurface(canvas, options)` returns a page-owned `Surface`.                                  | Pages without guests that draw pay nothing. One owner per canvas.                                                                                    |
| Grant           | A spawn option carries surface grants. The broker binds them in `spawnData()` as a runtime-reserved key, like `filesystem` and `pipeRegistry`.                      | Grants travel the existing admission path and are revoked with the process outcome. Children do not inherit unless the parent passes them on.        |
| Guest ABI       | New `runtime_window` import namespace. Blocking event read, nonblocking commands, negative WASI errno results, little-endian records.                               | Same conventions as `runtime_shm`. The namespace links whenever the page created a display; a process without grants sees zero surfaces.             |
| Input transport | One shared-memory ring per surface, single producer (the page's main thread), single consumer (the guest's event-loop thread).                                      | The main thread never blocks. The guest blocks in `Atomics.wait` on the ring's wake word, which keeps Preview 1 semantics.                           |
| Overflow        | Coalesce pointer motion, wheel and resize. Never drop key, button or focus records; on backlog overflow publish one `input-reset` record instead.                   | A dropped key-up sticks a key forever. A reset lets the guest release every held key and button.                                                     |
| winit           | Fork winit 0.30.13 with `platform_impl/waffle`, based on the orbital backend. Consumers apply it through `[patch.crates-io]`.                                       | Orbital's `run` is a blocking loop (1,593 lines in total), which matches a guest that blocks. The web backend (6,556 lines) depends on JS callbacks. |
| Rust layering   | The fork stays thin. ABI wrappers live in `waffle-window`, which the fork depends on.                                                                               | Apps without winit can use `waffle-window` directly, and the fork stays a small rebase per winit release.                                            |
| Window handle   | `RawWindowHandle::Web(WebWindowHandle { id })`, where `id` is the surface id. `RawDisplayHandle::Web`.                                                              | raw-window-handle 0.6 defines a `u32` web id. The wgpu backend reads it in `create_surface`. No JS object pointer exists in a WASI guest.            |
| Gestures        | Operations that browsers gate on a user gesture (pointer lock, fullscreen, keyboard lock) are **armed** by the guest and completed by the page on the next gesture. | A guest call never runs inside a DOM event handler, so it cannot satisfy the gesture rule directly.                                                  |

## Page API (TypeScript)

```ts
const display = await runtime.display();
const surface = display.createSurface(canvas, {
  inputTarget: canvas, // element that receives focus and key events; defaults to canvas
  ime: "textarea", // hidden <textarea> for composition; "off" disables IME
});
const child = await processes.spawn("/bin/horizon", { argv, surfaces: [surface] });
// ...
surface.dispose(); // revokes any grant, removes listeners, releases the ring
```

- `createSurface` calls `canvas.transferControlToOffscreen()` once and hands the OffscreenCanvas
  to the GPU bridge when a grant holder first creates a GPU surface for it
  ([GPU bridge: canvas ownership](gpu-bridge.md#canvas-and-surface-ownership)). The page keeps
  the element for layout, focus and listeners.
- A surface has at most one grant holder. Granting a held surface fails admission with `EBUSY`.
- `display.dispose()` and `runtime.dispose()` revoke grants after the process fences in
  [concepts](../docs/concepts.md#why-a-kill-takes-two-steps), then remove DOM listeners.
- The display module loads only on `runtime.display()`. Process activation, filesystem use and
  the network do not load it. It gets its own gzip budget in `tooling/runtime-size.ts`.

## Guest ABI: `runtime_window`

All addresses are guest addresses. Results are `0` or a byte count on success, or a negative WASI
errno: `-EBADF` (`-8`) for an unknown or revoked surface, `-EINVAL` (`-28`) for a bad span or
opcode, `-ENOTSUP` (`-58`) for an operation the browser cannot perform, `-EAGAIN` (`-6`) for a
full command queue.

```text
surfaces(out_ptr, out_len) -> count            granted surface ids, u32 each
surface_info(id, out{width, height, scale_milli, flags}) -> 0
                                               physical pixels; flags: focused, visible, fullscreen, pointer-locked
events_read(id, buf_ptr, buf_len, timeout_ns: i64, out{written, dropped}) -> 0
                                               blocks until at least one record, the deadline, or a wake;
                                               negative timeout waits forever; 0 polls
wake(id) -> 0                                  wakes a blocked events_read (EventLoopProxy, request_redraw from other threads)
command(id, opcode, arg_ptr, arg_len) -> 0     nonblocking; queued to the page in order
clipboard_read(id, buf_ptr, buf_len, timeout_ns, out{len}) -> 0
                                               last text the page published; see Clipboard
```

`events_read` copies whole records into guest memory, never a partial record. `dropped` counts
coalesced motion records, so a guest can tell that it fell behind.

### Records

Each record starts with `u16 kind, u16 len, u32 timestamp_ms` (page `performance.now()` truncated)
and is padded to 8 bytes. Kinds, with the winit event each becomes:

| Kind                  | Payload                                                               | winit                                                                     |
| --------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `resize`              | width, height (physical), scale_milli                                 | `ScaleFactorChanged` when scale changed, then `Resized`                   |
| `focus`               | focused                                                               | `Focused`                                                                 |
| `visibility`          | visible                                                               | `Occluded(!visible)`; `is_minimized()` reads it                           |
| `key`                 | state, repeat, location, modifiers, `code` string, `key` string, text | `KeyboardInput` with `PhysicalKey` and logical `Key`                      |
| `modifiers`           | modifier bits                                                         | `ModifiersChanged`                                                        |
| `pointer-move`        | x, y (physical, f64)                                                  | `CursorMoved` (coalesced)                                                 |
| `pointer-delta`       | dx, dy (f64, while locked)                                            | `DeviceEvent::MouseMotion` (summed when coalesced)                        |
| `button`              | state, button                                                         | `MouseInput`                                                              |
| `wheel`               | delta mode, dx, dy                                                    | `MouseWheel` with `LineDelta` or `PixelDelta` (summed)                    |
| `pointer-enter/leave` | (none)                                                                | `CursorEntered` / `CursorLeft`                                            |
| `pointer-lock`        | locked, error                                                         | Grab state; `Focused(false)` is not implied                               |
| `ime`                 | phase (enabled, preedit, commit, disabled), cursor range, text        | `Ime::*`                                                                  |
| `frame`               | (none)                                                                | `RedrawRequested` when a redraw was requested                             |
| `dropped-file`        | guest path the page already wrote                                     | `DroppedFile(PathBuf)`                                                    |
| `close-requested`     | (none)                                                                | `CloseRequested` (page-initiated, e.g. a close button)                    |
| `input-reset`         | (none)                                                                | Synthesized releases for every held key and button, then `Focused(false)` |

The page forwards `KeyboardEvent.code`, `.key`, `.location`, `.repeat` and modifier state as
strings and bits. The winit fork reuses winit's web tables
(`platform_impl/web/keyboard.rs:9,324`), which are plain string matches with no web-sys
dependency, to produce `PhysicalKey` and `Key`. `KeyEventExtra.key_without_modifiers` comes from
`navigator.keyboard.getLayoutMap()` where it exists (Chromium) and otherwise from `key` with shift
removed for ASCII. Record the fallback's limits in public docs.

### Commands

| Opcode                | Effect on the page                                                                            | Browser constraint                                                        |
| --------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `set-title`           | Fires a `title` event on the `Surface`; the embedder decides whether to set `document.title`. | None.                                                                     |
| `set-cursor-icon`     | Sets the canvas CSS cursor from winit's `CursorIcon` name.                                    | None. Custom cursor images return `-ENOTSUP` in the first release.        |
| `set-cursor-visible`  | `cursor: none` while hidden.                                                                  | None.                                                                     |
| `cursor-grab`         | `Locked` arms pointer lock; `None` exits it. `Confined` returns `-ENOTSUP`.                   | Needs a gesture. Esc always exits. Chrome refuses a relock for about 1 s. |
| `set-cursor-position` | Returns `-ENOTSUP`.                                                                           | Browsers do not warp the cursor.                                          |
| `fullscreen`          | Arms or exits `requestFullscreen` on the input target. `Exclusive` is treated as borderless.  | Needs a gesture.                                                          |
| `keyboard-lock`       | Arms `navigator.keyboard.lock()` while fullscreen (Chromium).                                 | Without it, Ctrl/Cmd+W, T, N, Q and Esc stay with the browser.            |
| `ime-allowed`         | Focuses or blurs the hidden composition `<textarea>`.                                         | None.                                                                     |
| `ime-cursor-area`     | Moves the `<textarea>` so candidate windows appear near the caret.                            | None.                                                                     |
| `request-redraw`      | Sets a word the page reads on each `requestAnimationFrame`; the next tick emits `frame`.      | rAF stops in hidden tabs, so no `frame` arrives while hidden.             |
| `clipboard-write`     | `navigator.clipboard.writeText` from the page.                                                | Needs focus. Failure is reported as a `clipboard` event to the embedder.  |

An **armed** operation completes inside the page's next `pointerdown` or `keydown` handler on the
input target, then reports its result as a `pointer-lock` or `resize`/`focus` record. Arms expire
when the guest disarms them or the surface loses focus.

### Clipboard

`navigator.clipboard.readText` is asynchronous and needs permission or a gesture, so the guest
never reads the system clipboard directly. The page listens for `paste` on the input target and
publishes the text in the surface's clipboard slot, then delivers the key event that triggered it.
`clipboard_read` returns that slot. This keeps Ctrl+V working with no permission prompt. Apps that
want the clipboard at other times get only what the page last published.

### Gamepads

`navigator.getGamepads()` exists only in window realms and must be polled. A later slice adds a
per-surface gamepad snapshot (buttons, axes, mapping, connected) written by the page on each rAF
tick and read with a `gamepads_read` import. winit has no gamepad API; consumers read it through
`waffle-window` directly. Not part of the first release.

## Rust side

### `waffle-window` (Waffle-owned crate)

Safe wrappers over `runtime_window`: `Surface`, typed `Event` decoding, `Command` encoding,
`wake()`, and the clipboard slot. It has no winit dependency and works for apps that do not use
winit. It lives in the guest-crates repository
([where the code lives](guest-graphics.md#where-the-code-lives)) and builds for `wasm32-wasip1` and
`wasm32-wasip1-threads`.

### The winit fork

A fork of winit at the `v0.30.13` tag, kept as a single branch with one commit series on top:

1. `build.rs`: add `waffle_platform: all(target_family = "wasm", target_os = "wasi")`. Narrow the
   `target_family = "wasm"` dependency block (js-sys, wasm-bindgen, web-sys, web-time;
   `Cargo.toml:335-350`) to `target_os = "unknown"` so WASI builds do not pull in wasm-bindgen.
2. `platform_impl/mod.rs`: select `platform_impl/waffle` for `waffle_platform`
   (`platform_impl/mod.rs:4-33,68-78`).
3. `platform_impl/waffle/`, modelled on `platform_impl/orbital` (`event_loop.rs` 829 lines,
   `window.rs` 509, `mod.rs` 255). It provides `EventLoop`, `ActiveEventLoop`, `EventLoopProxy`,
   `OwnedDisplayHandle`, `Window`, `WindowId`, `DeviceId`, `MonitorHandle`, `VideoModeHandle`,
   `KeyEventExtra { key_without_modifiers, text_with_all_modifiers }`, `OsError`,
   `PlatformSpecificWindowAttributes`, `PlatformIcon` and `PlatformCustomCursor[Source]`.
4. Add `waffle_platform` to the `modifier_supplement` cfg (`platform/mod.rs:24-52`) and to the
   `std::time` branch in `event_loop.rs:16-19` and `event.rs:39-45`.

`EventLoop::run` copies orbital's loop (`orbital/event_loop.rs:500-700`): drain records, emit
window and device events, emit `RedrawRequested` for windows with a pending redraw on `frame`,
emit `AboutToWait`, then block in `events_read` with a timeout derived from `ControlFlow`
(`Poll` → 0, `Wait` → forever, `WaitUntil` → deadline), and emit `LoopExiting` on exit.

`Window::new` takes the next unclaimed granted surface. `WindowAttributes` that the page owns
(size, position, decorations, resizable, always-on-top) are ignored, and `inner_size()` reports the
canvas's physical size. A second `Window::new` with no free grant returns `OsError` with a clear
message. `Window` is `Send + Sync`; every operation is a `command`.

`MonitorHandle` reports one monitor from `screen.width/height`, `devicePixelRatio` and a
`refresh_rate_millihertz` measured from rAF, with one synthetic `VideoModeHandle`.

### Where the fork lives

Not in this repository. winit 0.30.13 is about 57,000 lines of upstream Rust (`src/`), and the
Waffle patch is about 2,000. Keep it as a fork (for example a `waffle-0.30` branch) that depends on
`waffle-window` by exact Git revision, either in its own fork repository or inside the guest-crates
repository ([open question](guest-graphics.md#open-questions-for-the-owner)). Consumers pin both.

Upstreaming is not planned: 0.30 is a maintenance branch and 0.31 changes the API. Revisit after
the first consumer ships.

## Delivery slices and effort

| Slice                   | Rough effort | Deliverable and exit gate                                                                                                                                                               |
| ----------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W0. Ring and records    | 3–4 days     | `runtime.display()`, `createSurface`, the input ring, record encoding, coalescing and `input-reset`. Unit tests drive synthetic DOM events through the ring and read them in a worker.  |
| W1. Grants and ABI      | 3–5 days     | Spawn option, `spawnData()` binding, revocation on every outcome, `runtime_window` imports. A Preview 1 C fixture prints its events; a kill at each admission stage leaves no listener. |
| W2. `waffle-window`     | 2–3 days     | Rust crate with decoding and commands; a Rust fixture echoes keys and resizes on `wasm32-wasip1`.                                                                                       |
| W3. winit fork          | 5–8 days     | `platform_impl/waffle`; winit's own `window` example runs in Chromium, Firefox and WebKit with keyboard, mouse, resize, focus and `ControlFlow::{Poll,Wait,WaitUntil}`.                 |
| W4. Gesture operations  | 3–5 days     | Pointer lock, fullscreen, keyboard lock, clipboard paste, IME textarea. Manual browser checklist plus Playwright where the engine can simulate the gesture.                             |
| W5. Threads and release | 3–5 days     | With [guest threads](wasi-threads.md): `wake` from another thread, `Window` used from workers. Public docs, size budget, status page.                                                   |

W0–W4 total **16–25 engineer-days**. W5 waits for thread support S4. W0–W4 do not depend on threads
or on the GPU bridge: a test program can read input and report it on stdout.

## Acceptance

- A guest's input stops, and the page removes its listeners, at every process outcome, including
  kill during admission and kill while blocked in `events_read`.
- No key or button is lost without an `input-reset`. A test floods motion while holding keys and
  checks that every press has a matching release.
- `events_read` with a deadline returns within one scheduler tick of it; `wake` from another
  worker ends a forever wait.
- Pointer lock, fullscreen and keyboard lock work after one click in Chromium, Firefox and Safari
  on macOS; the result arrives as a record either way.
- An ordinary filesystem-only page fetches nothing new. `bun run size` stays inside the core
  budget; the display chunk has its own.
- A program that imports `runtime_window` on a page without a display fails at link time with a
  clear error. With a display but no grant, `surfaces` returns zero and winit's `Window::new`
  fails with a message naming the missing grant.

## Risks

- **Keyboard fidelity.** `code` matches winit's `KeyCode`, but dead keys, AltGr and
  `key_without_modifiers` outside Chromium are approximations.
- **Gesture timing.** Games that request pointer lock from a menu click get the lock one gesture
  later than on desktop. Horizon already falls back from `Locked` to `None`.
- **Reserved shortcuts.** Without keyboard lock, browser shortcuts win. Document them.
- **Background tabs.** rAF stops, so a guest that waits for `frame` stops rendering, which is the
  intended behavior. A guest on `ControlFlow::Poll` keeps running its simulation.
- **Fork maintenance.** Each winit 0.30.x release needs a rebase. The patch touches four upstream
  files plus a new directory.
