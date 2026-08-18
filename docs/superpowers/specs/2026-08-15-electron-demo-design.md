# @unitrack/electron-demo — Design Spec

Date: 2026-08-15

## Purpose

The first host application in this monorepo, and the first end-to-end
proof that `@unitrack/core`, `@unitrack/source-local-fs`, and
`@unitrack/engine-web-audio` actually work together to produce audible
sound. Every prior package in this monorepo has been verified only
against mocks/stubs; this app is the first real integration point.

## Scope

**In scope:** a minimal Electron window with a native "Open File" dialog
and Play/Pause/Stop controls, wiring `@unitrack/core` to
`@unitrack/source-local-fs` (Source Provider) and
`@unitrack/engine-web-audio` (Playback Engine), so a user can pick a local
audio file and hear it play.

**Explicitly out of scope:**
- Playlist/queue UI (multiple tracks, reordering) — one file at a time.
- Scrubbing/seeking UI, progress bar, volume control.
- Packaging or distribution (`electron-builder` or similar) — this app is
  run via `electron .` in development only.
- Automated tests — verification is manual, via the `run` skill. See
  Testing below for why.
- `@unitrack/source-local-fs`'s or `@unitrack/engine-web-audio`'s own
  behavior — both are already fully implemented, tested, and merged; this
  app only wires them together.

## Architecture

**Process model: `nodeIntegration: true`, `contextIsolation: false`, in
this one demo window.** `CorePlayer` needs both `node:fs` (via
`@unitrack/source-local-fs`) and DOM/Web Audio (via
`@unitrack/engine-web-audio`) available in the *same* JavaScript context,
since the core's own design spec mandates in-process, non-sandboxed
plugins — there is no IPC boundary in `CorePlayer`'s plugin contract to
cross. Modern Electron's recommended security posture (main process owns
Node, renderer is sandboxed, a `contextBridge` preload exposes a narrow
API) would require building an IPC-based proxy `PlaybackEngine` — real
extra complexity the core was never designed to need, and unwarranted for
a local-only demo that loads no remote content. This choice is scoped to
this demo; it is not a precedent for a future production host.

One Electron API still requires the main process regardless of
`nodeIntegration`: `dialog.showOpenDialog` (the `remote` module that used
to let renderers call this directly was removed from Electron years ago).
So one IPC round-trip is unavoidable no matter which process model is
chosen — `main.js` registers `ipcMain.handle('open-file-dialog', ...)`,
`preload.mjs` calls `ipcRenderer.invoke('open-file-dialog')`.

**Everything else lives in an unsandboxed ESM preload script, not a
`<script type="module">` in the page.** An earlier draft of this spec
assumed `nodeIntegration: true` would let a page-level `<script
type="module">` resolve bare specifiers (`@unitrack/core`) and `node:`
builtins via Node-style resolution. That assumption is wrong: renderer
`<script type="module">` tags are always resolved by Chromium's own ESM
loader, which has no concept of `node_modules` or the `node:` scheme,
regardless of `nodeIntegration`. `nodeIntegration: true` only injects
Node globals (`require`, `process`, ...) into the page's own context for
classic (non-module) scripts — it does not redirect the module loader.

The correct place for `CorePlayer` construction is an **ESM preload
script** (`preload.mjs` — the `.mjs` extension is required; Electron
ignores `"type": "module"` for preload files). Preload scripts are loaded
through Node's own ESM loader, so bare specifiers and `node:` builtins
resolve normally there. `main.js` points `webPreferences.preload` at it
and sets `sandbox: false` (a sandboxed preload cannot use static ESM
imports at all). With `contextIsolation: false`, the preload script
shares the same JavaScript realm as the page — so code in `preload.mjs`
can add DOM event listeners and mutate the page directly, exactly as a
page-level script would, once it runs after `DOMContentLoaded` (the
preload script executes before the HTML body exists, so DOM lookups must
be deferred to that event).

## Package

```
apps/electron-demo/
├── package.json
├── tsconfig.json
├── main.js
├── index.html
└── preload.mjs
```

The root `package.json`'s `"workspaces"` field changes from
`["packages/*"]` to `["packages/*", "apps/*"]` — the one necessary root
change, since this is the first package to live under `apps/` rather than
`packages/`.

**Dependencies are real, not devDependency-only.** Unlike
`@unitrack/source-local-fs` and `@unitrack/engine-web-audio` (which only
needed `@unitrack/core` for JSDoc types), this app genuinely imports and
calls `@unitrack/core`, `@unitrack/source-local-fs`, and
`@unitrack/engine-web-audio` at runtime — all three are `dependencies`.
`electron` is a `devDependency`, following Electron's own convention (it's
the launcher/runtime, not a library the app's code is distributed with).

## Wiring

`main.js`: creates a `BrowserWindow` with `webPreferences: {
nodeIntegration: true, contextIsolation: false, sandbox: false, preload:
<path to preload.mjs> }`, loads `index.html`, and handles
`'open-file-dialog'` over IPC via `dialog.showOpenDialog` filtered to
common audio extensions.

`preload.mjs`: on `DOMContentLoaded`, constructs one `CorePlayer`,
registers `createLocalFileSourceProvider()` and
`createWebAudioPlaybackEngine()`, sets policy to `[{ kind: 'local' }]`. On
"Open File": invokes the IPC dialog, and if a path was picked, clears the
queue, adds a single `LogicalTrack` whose one `SourceRef` points at that
path (`{ pluginId: 'local-fs', sourceId: filePath, kind: 'local' }`), and
calls `core.play()`. Play/Pause/Stop buttons call
`core.play()`/`pause()`/`stop()` directly. A status line subscribes to
`core.on('stateChanged'/'trackChanged', ...)` to show the current status
and track title, and to `core.on('error', ...)` to surface failures
visibly — nothing fails silently, consistent with the rest of this
project. The last error's reason (and any `failedSources` detail) is held
in a variable and re-rendered whenever the status is `'error'`, since
`CorePlayer` emits `'error'` immediately followed by `'stateChanged'` —
without this, the generic status text overwrites the specific reason in
the same tick.

## Testing

No automated tests for this package. Verification is manual, via the
`run` skill: build and launch the app, pick a real audio file, confirm
sound is actually audible and the status line reflects state changes.
This is a deliberate choice, not an oversight — this app's entire purpose
is to be the first real-world check that the pipeline produces audible
sound, which no mock/stub-based automated test could verify. `npm
run typecheck` still applies for consistency with every other package in
this monorepo (`tsc --checkJs --strict`, `"lib": ["ES2022", "DOM"]` plus
`@types/node`, since `main.js` is pure Node and `preload.mjs` is a
Node+DOM hybrid).

## Logging (added 2026-08-18)

This app logs verbosely and unconditionally — main-process lifecycle and
crash events, every IPC call, every UI interaction, and every
`CorePlayer` event. That is a deliberate standing convention for this
package rather than temporary debug code, and it is specified in full in
the "Logging" section of
`2026-08-17-electron-demo-queue-ui-design.md`. It follows directly from
the "no automated tests, manual verification only" decision above: with
no test signal, the terminal is the only signal, and a silent terminal
turns every bug into several rounds of manual re-runs.

## Non-goals

Restated from Scope: playlist UI, scrubbing/progress/volume controls,
packaging/distribution, and automated tests are all out of scope for this
app.
