# @unitrack/electron-demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@unitrack/electron-demo` — a minimal Electron host wiring `@unitrack/core` to `@unitrack/source-local-fs` and `@unitrack/engine-web-audio`, with a native "Open File" dialog and Play/Pause/Stop controls — as specified in `docs/superpowers/specs/2026-08-15-electron-demo-design.md`.

**Architecture:** A single new workspace package under `apps/`, `apps/electron-demo/`. `main.js` (the Electron main process) creates one `BrowserWindow` with `nodeIntegration: true`/`contextIsolation: false` and handles the one Electron API that must run in the main process regardless (`dialog.showOpenDialog`, invoked over IPC). `renderer.js` (an ES module loaded by `index.html`) constructs one `CorePlayer`, registers both plugins, and wires the UI directly to `core.play()`/`pause()`/`stop()` and `core.queue`.

**Tech Stack:** Plain JavaScript (ESM) with JSDoc types checked via `tsc --checkJs` (`"lib": ["ES2022", "DOM"]` plus `@types/node`, since `main.js` is pure Node and `renderer.js` is a Node+DOM hybrid). No automated tests — this app's own purpose is to be the first real audible-sound verification, done manually via the `run` skill after this task completes; that verification is not part of this task's automated steps (a sandboxed subagent has no display or audio device to confirm sound with).

## Global Constraints

- This is the first plan in this monorepo to modify the root `package.json` — its `"workspaces"` field changes from `["packages/*"]` to `["packages/*", "apps/*"]`, since this package lives under `apps/`, not `packages/`.
- `@unitrack/core`, `@unitrack/source-local-fs`, and `@unitrack/engine-web-audio` are real `dependencies` here (not devDependency-only like the two prior plugin packages), since this app genuinely imports and calls all three at runtime. `electron` is a `devDependency`, per Electron's own convention.
- `nodeIntegration: true`/`contextIsolation: false` is a deliberate, scoped choice for this local-only demo (see design spec) — not a pattern to carry into a future production host.
- No playlist UI, no scrubbing/progress bar/volume control, no packaging/distribution tooling, no automated tests. `npm run typecheck` still applies (`tsc --checkJs --strict`), for consistency with every other package in this monorepo.
- `npm run typecheck`, run from the repo root, must pass cleanly across all four workspace packages at the end of the task. `npm test` from the repo root must still pass for the three packages that have tests (`@unitrack/core`, `@unitrack/source-local-fs`, `@unitrack/engine-web-audio`) — this package has no `"test"` script, and the root's `--if-present` flag correctly skips it rather than failing.

---

## Task 1: Scaffold and implement @unitrack/electron-demo

**Files:**
- Modify: root `package.json` (add `"apps/*"` to `"workspaces"`)
- Create: `apps/electron-demo/package.json`
- Create: `apps/electron-demo/tsconfig.json`
- Create: `apps/electron-demo/main.js`
- Create: `apps/electron-demo/index.html`
- Create: `apps/electron-demo/renderer.js`

**Interfaces:**
- Consumes: `CorePlayer` from `@unitrack/core` (real runtime import — `registerSourceProvider`, `registerPlaybackEngine`, `setPolicy`, `play`/`pause`/`stop`, `queue.add`/`queue.clear`, `on('stateChanged'|'trackChanged'|'error', ...)`, `getState()`); `createLocalFileSourceProvider` from `@unitrack/source-local-fs`; `createWebAudioPlaybackEngine` from `@unitrack/engine-web-audio`. All three are already fully implemented, tested, and merged — this task does not modify any of them.
- Produces: a launchable Electron app (`npm start` from `apps/electron-demo/`, or `npm start -w @unitrack/electron-demo` from the repo root) with no further public interface — this is a terminal application, not a library other packages depend on.

- [ ] **Step 1: Add `apps/*` to the root workspace glob**

In the repo root `package.json`, change:

```json
  "workspaces": [
    "packages/*"
  ],
```

to:

```json
  "workspaces": [
    "packages/*",
    "apps/*"
  ],
```

- [ ] **Step 2: Create `apps/electron-demo/package.json`**

```json
{
  "name": "@unitrack/electron-demo",
  "version": "0.1.0",
  "private": true,
  "description": "Minimal Electron demo host for @unitrack/core",
  "type": "module",
  "main": "main.js",
  "scripts": {
    "start": "electron .",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@unitrack/core": "^0.1.0",
    "@unitrack/source-local-fs": "^0.1.0",
    "@unitrack/engine-web-audio": "^0.1.0"
  },
  "devDependencies": {
    "@types/node": "^18",
    "electron": "^31.0.0",
    "typescript": "^5.5.4"
  }
}
```

No `"test"` script — this package has no automated tests (see Global Constraints).

- [ ] **Step 3: Create `apps/electron-demo/tsconfig.json`**

```json
{
  "compilerOptions": {
    "allowJs": true,
    "checkJs": true,
    "noEmit": true,
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["main.js", "renderer.js"]
}
```

This package has no `src/` subdirectory — `main.js`/`renderer.js` sit at the package root, matching how Electron apps conventionally reference their entry points, so `include` lists them directly rather than a glob.

- [ ] **Step 4: Install from the repo root**

Run (from the repo root, not from inside `apps/electron-demo`): `npm install`
Expected: npm recognizes the new `apps/electron-demo` workspace member (picked up by the `apps/*` glob added in Step 1), links `node_modules/@unitrack/core`, `node_modules/@unitrack/source-local-fs`, and `node_modules/@unitrack/engine-web-audio` as workspace symlinks into `apps/electron-demo`'s resolution path, and installs `electron`/`@types/node`/`typescript`.

- [ ] **Step 5: Create `apps/electron-demo/main.js`**

```js
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @returns {void} */
function createWindow() {
  const win = new BrowserWindow({
    width: 480,
    height: 320,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

ipcMain.handle('open-file-dialog', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
```

- [ ] **Step 6: Create `apps/electron-demo/index.html`**

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>unitrack demo</title>
</head>
<body>
  <button id="open-file">Open File</button>
  <button id="play">Play</button>
  <button id="pause">Pause</button>
  <button id="stop">Stop</button>
  <p id="status">idle</p>
  <script type="module" src="./renderer.js"></script>
</body>
</html>
```

- [ ] **Step 7: Create `apps/electron-demo/renderer.js`**

```js
import { ipcRenderer } from 'electron';
import { CorePlayer } from '@unitrack/core';
import { createLocalFileSourceProvider } from '@unitrack/source-local-fs';
import { createWebAudioPlaybackEngine } from '@unitrack/engine-web-audio';

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
function requireElement(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id} element`);
  return el;
}

const core = new CorePlayer();
core.registerSourceProvider(createLocalFileSourceProvider());
core.registerPlaybackEngine(createWebAudioPlaybackEngine());
core.setPolicy([{ kind: 'local' }]);

const statusEl = requireElement('status');

/** @returns {void} */
function updateStatus() {
  const state = core.getState();
  const title = state.currentQueueItem?.track.metadata.title ?? '(no track)';
  statusEl.textContent = `${state.status} — ${title}`;
}

core.on('stateChanged', updateStatus);
core.on('trackChanged', updateStatus);
core.on('error', (/** @type {any} */ payload) => {
  statusEl.textContent = `error: ${payload.reason}`;
});

requireElement('open-file').addEventListener('click', async () => {
  const filePath = await ipcRenderer.invoke('open-file-dialog');
  if (!filePath) return;
  const title = filePath.split(/[\\/]/).pop() ?? filePath;
  core.queue.clear();
  core.queue.add({
    id: filePath,
    metadata: { artist: '', album: '', title },
    sources: [{ pluginId: 'local-fs', sourceId: filePath, kind: 'local' }],
  });
  await core.play();
});

requireElement('play').addEventListener('click', () => core.play());
requireElement('pause').addEventListener('click', () => core.pause());
requireElement('stop').addEventListener('click', () => core.stop());

updateStatus();
```

Note: `core.on('error', (/** @type {any} */ payload) => {...})` needs the explicit `@type {any}` annotation on `payload` because `@unitrack/core`'s `EventEmitter.on` declares its `handler` parameter as a bare `@param {Function} handler` — under `tsc --checkJs --strict`, a function literal passed to a bare-`Function`-typed parameter doesn't get contextual typing for its own parameters, so `payload` would otherwise be flagged as implicit-any. This is the first external (outside `packages/core`) call site to hit this; consider tightening `EventEmitter.on`'s JSDoc type in a future plan (matching how `PlaybackEngine.on` was already typed as `(payload?: any) => void` instead of bare `Function` in the original core plan) — out of scope to fix here, since it would mean modifying the already-merged `@unitrack/core` package as a side effect of this app.

- [ ] **Step 8: Run the typecheck**

Run: `npm run typecheck -w @unitrack/electron-demo`
Expected: no errors. If something doesn't resolve or type-check as written, fix it forward with the smallest correct annotation/cast (the same class of issue found and fixed in both `source-local-fs` and `engine-web-audio`'s plans) and note the deviation in your report.

- [ ] **Step 9: Syntax-check both entry points**

Run: `node --check apps/electron-demo/main.js` and `node --check apps/electron-demo/renderer.js`
Expected: both exit cleanly (no output means success). This confirms valid JS syntax only — it does not (and cannot, in a sandboxed environment with no display or audio device) confirm the app actually launches, shows a window, or produces sound. That verification happens separately, manually, via the `run` skill, after this task is complete and reviewed — do not attempt to run `npm start` and interpret its outcome; a headless environment cannot open an Electron `BrowserWindow`.

- [ ] **Step 10: Verify the rest of the workspace still passes from the root**

Run: `npm test` and `npm run typecheck` from the repo root.
Expected: `npm test` delegates into `@unitrack/core`, `@unitrack/source-local-fs`, and `@unitrack/engine-web-audio` (skipping `@unitrack/electron-demo`, which has no `"test"` script) and passes — 98 tests, all prior. `npm run typecheck` delegates into all four packages and passes with zero errors.

- [ ] **Step 11: Commit**

```bash
git add package.json package-lock.json apps/electron-demo
git commit -m "feat: add @unitrack/electron-demo, a minimal Electron demo host"
```
