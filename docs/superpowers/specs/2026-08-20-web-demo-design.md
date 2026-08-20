# @unitrack/web-demo — Design Spec

Date: 2026-08-20

## Purpose

The second host app, after `@unitrack/electron-demo`, and the first to run
in a plain browser tab — no Electron, no Node main/preload split, no
filesystem access. `@unitrack/electron-demo`'s own README description
("the first end-to-end proof the pipeline produces audible sound") was
never actually a proof that the pipeline is platform-independent, only
that it works inside Electron's embedded Chromium with Node available in
the same process. This app is that missing proof: composing only
`any`-tier and `web`-tier plugins (`@unitrack/source-subsonic`,
`@unitrack/source-s3`, `@unitrack/engine-audio-queue`) in a host with zero
Node APIs available at runtime, served as plain static files a browser
loads directly.

It is also the first host to register **two networked `SourceProvider`s at
once** — `@unitrack/electron-demo` only ever registers
`@unitrack/source-local-fs`. `@unitrack/source-subsonic`'s own design spec
observed that `Resolver.js`'s policy/fallback machinery "has never actually
been exercised: with one provider, there is nothing to fall back *from*."
That is still true of every host in this repo today. This app's "Add
Track" form can attach both a Subsonic source and an S3 source to the same
`LogicalTrack`, so `Resolver.js`'s policy ordering and fallback-on-failure
path run live, against two real network backends, for the first time.

## Scope

**In scope:** a static-file dev server (no bundler — see "Why import maps,
not a bundler" below) serving an `index.html` + a browser ES module that
constructs a `CorePlayer`, registers `@unitrack/source-subsonic`,
`@unitrack/source-s3`, and `@unitrack/engine-audio-queue`, and exposes:
connection forms for a Subsonic server and an S3 bucket (credentials held
in memory only, never persisted); an "Add Track" form that builds a
`LogicalTrack` with one or two `SourceRef`s (a primary + an optional
fallback of the other kind); transport controls (play/pause/stop/seek/
volume); a read-only queue list (click a row to jump to it — no drag
reorder, see Non-goals).

**Explicitly out of scope:**
- Any bundler/transpiler step (esbuild, Vite, Rollup, webpack) — this
  repo's stated principle, "There is no build step — the source you read
  is the source that runs" (root `README.md`), extends here via import
  maps instead. See below.
- A service worker, offline caching, or PWA manifest.
- Any `desktop`-tier plugin (`source-local-fs`, `playlist-local-fs`,
  `metadata-local-fs`) — none of them are importable in a browser at all
  (`node:fs`), which is exactly the point of this app existing.
- Persisting connection credentials (`localStorage`, cookies, a config
  file) — typed into the form each session, kept only in an in-memory
  `CorePlayer`-adjacent closure. A real deployment's credential handling is
  a host concern beyond a demo's scope, the same posture
  `@unitrack/source-subsonic`/`@unitrack/source-s3` take toward obtaining
  credentials in the first place.
- Drag-to-reorder queue UI, shuffle/repeat controls, folder scanning — all
  present in `@unitrack/electron-demo` today, all skipped here to keep this
  app's actual point (prove the browser/no-bundler pipeline works) from
  drowning in UI surface that has already been proven once. A future pass
  can port them over if this app grows into more than a proof.
- `nowPlaying`/nowPlaying-capable engine work — a separate, not-yet-built
  capability (see the `2026-08-19-playback-coordination-delivery-contract
  -v0.4-design.md` spec's `NowPlayingInfo`/`setNowPlaying`), intentionally
  deferred until there are at least two real hosts to validate it against
  (this app becoming the second host is a prerequisite, not a part of this
  spec's own scope).
- Deploying this anywhere (a real static host, a CDN, HTTPS). Runs via
  `node server.js` on `localhost` only, exactly as `electron .` only ever
  runs `@unitrack/electron-demo` locally today.

## Why import maps, not a bundler

Every package in this repo is plain ESM with bare specifiers
(`import { CorePlayer } from '@unitrack/core'`). Node resolves those via
npm workspace symlinks under `node_modules/@unitrack/*`, following each
package's own `package.json` `exports.import` condition — the same
mechanism `@unitrack/electron-demo`'s preload script relies on. A browser's
native `<script type="module">` has **no bare-specifier resolution at
all** without help — `import '@unitrack/core'` fails outright with no
import map present.

A bundler (Vite, esbuild) is the conventional fix, but it is a real,
repo-wide precedent change: introducing one here would mean this app's
"source" is no longer directly what runs — a build artifact would be,
which is exactly the property the root README calls out as a deliberate
project-wide choice for every other package. **Browser import maps**
(`<script type="importmap">`, baseline-supported since 2023 in every
evergreen browser this app targets) solve the identical problem — mapping
a bare specifier to a concrete URL — without a build step: the browser
still loads and executes `packages/core/src/index.js` directly, byte for
byte, the same file Node loads. `server.js` (see Interface) generates the
import map at request time by reading every workspace package's own
`package.json.exports` — the exact same data Node's own resolver already
reads — so the map can never silently drift from what Node considers each
package's public surface; there is no second, hand-maintained source of
truth for what resolves where.

This app is therefore the trade-off this choice makes visible: no HMR, no
minification, no tree-shaking, one `<script>` tag per module graph node
(dozens of small requests instead of one bundle) — acceptable for a
development-only demo app (`@unitrack/electron-demo` is exactly as
unoptimized, per its own package.json having no `build` script at all),
not a decision this spec makes on behalf of a real production web build,
should one ever be built as a separate, later app.

## Server

`server.js` — a small `node:http` server, no framework:

1. Walks `node_modules/@unitrack/*` (every workspace package is linked
   there regardless of whether this app directly depends on it — so a
   transitive-only dependency like `@unitrack/media-delivery-web`, pulled
   in by `@unitrack/engine-audio-queue`, resolves correctly with zero
   special-casing). For each package, reads its `package.json.exports`
   and adds one import-map entry per key: `"."` → the bare package name,
   `"./types"` → `"<packageName>/types"`, each pointing at
   `/node_modules/<packageName>/<exports entry's "import" path>`.
2. Serves that generated import map inlined into `index.html` (replacing a
   `%%IMPORT_MAP%%` placeholder in a static template) for `GET /`.
   Inlined, not an external `<script type="importmap" src="...">` — broader
   and longer-standing browser support, and it means the map is always
   freshly regenerated on every page load with zero caching-invalidation
   concerns during development.
3. Serves static files under the app's own directory and under
   `node_modules/` (so every mapped import URL above actually resolves) —
   plain `fs.readFile` + a small extension→MIME-type table. `.js`/`.mjs`
   files are served as `text/javascript` (not `application/octet-stream`
   or a missing header) — required for the browser's strict module
   MIME-type enforcement to accept them as ES modules at all.
4. No live-reload, no caching headers beyond the browser default — a
   deliberately minimal dev server, matching this app's own "prove the
   pipeline, not build production infrastructure" scope.

## Interface

```
apps/web-demo/
├── package.json     — dependencies: @unitrack/core, @unitrack/source-subsonic,
│                       @unitrack/source-s3, @unitrack/engine-audio-queue;
│                       devDependencies: @types/node, typescript
├── tsconfig.json     — lib: ["ES2022", "DOM"] (main.js touches the DOM;
│                       server.js is Node-only) + @types/node, same combined-
│                       lib pattern @unitrack/electron-demo's tsconfig.json
│                       already uses for its own Node+DOM file mix
├── server.js         — the static/import-map server described above
├── index.template.html — static template with a %%IMPORT_MAP%% placeholder
├── plugins.js         — host plugin manifest, mirrors electron-demo/plugins.js's
│                         PLUGIN_MANIFEST pattern (no per-process split needed —
│                         there is only one process here)
└── main.js            — the browser module: constructs CorePlayer, registers
                          plugins, wires the connection/add-track forms and
                          transport controls to Core's public API and events
```

`main.js` follows the same event-wiring shape `@unitrack/electron-demo`'s
`preload.mjs` already established (`core.on('stateChanged'|'trackChanged'|
'queueChanged'|'error'|'positionChanged', ...)` driving DOM updates) —
reused directly, not redesigned, since that pattern is already proven and
this app's whole point is to prove the *pipeline*, not to explore new UI
architecture.

**Connection forms** don't call `registerSourceProvider()` immediately on
page load — `@unitrack/source-subsonic`/`@unitrack/source-s3` both need
config (baseUrl/credentials, endpoint/bucket/keys) only available once the
user fills in a form. Each form's submit handler constructs the provider
via its factory and registers it at that point; `core.initializePlugins()`
is (re-)invoked after either registration, matching the v0.4 contract's
"every registered plugin's `initialize()` must run before the first
`play()`" requirement `@unitrack/electron-demo` already documents.

## Testing

`@unitrack/electron-demo` has no automated tests "by design: its entire
purpose is to verify audible output, which no stub can prove... checked
manually" (root README). The same audible-output limitation applies here
identically — but unlike Electron, a plain browser page is directly
drivable by a headless Chromium instance without any of Electron's own
IPC/process-model complexity standing in the way. So this app adds one
thing `@unitrack/electron-demo` doesn't have: a best-effort headless
smoke test (Playwright against the pre-installed sandbox Chromium, run
manually during development — not wired into CI, since CI has no audio
device and this is still fundamentally a manual-verification app) that
loads the page and asserts, without needing a real Subsonic/S3 server
reachable: the import map resolves every bare specifier with zero console
errors, `CorePlayer` constructs, both source providers and the playback
engine register successfully, and `core.initializePlugins()` resolves —
proving the browser/import-map wiring itself is sound, even though actual
audible playback still requires a human with real server credentials, same
as Electron.

## Non-goals

Restated from Scope: bundling/transpilation, service worker/offline,
desktop-tier plugins, credential persistence, drag-reorder/shuffle/repeat/
folder-scan UI, `nowPlaying` integration, and any real deployment are all
out of scope for this app.
