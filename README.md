# unitrack

A headless, plugin-based music player core — UI-, backend-, and
platform-independent.

The central idea: a **logical track** is not a file. It is an identity that may
have several physical incarnations — a local FLAC, a self-hosted stream, a
track on a streaming service — and the core picks which one to actually play
according to a configurable policy. Everything concrete (where audio comes
from, how it is decoded, where metadata is read) lives in plugins; the core
knows only the domain model and the plugin contracts.

Written in plain JavaScript with JSDoc types, checked by `tsc --checkJs`.
There is no build step — the source you read is the source that runs.

## Architecture

```
┌───────────────────────────────────────────────────┐
│                    Core Player                    │
│   (public API: play/pause/next/seek/getState)     │
├───────────────────────────────────────────────────┤
│   Queue Manager   │   Resolver   │  Playback Orch. │
├───────────────────────────────────────────────────┤
│                  Plugin Registry                  │
├──────────┬──────────┬───────────┬─────────────────┤
│  Source  │ Playback │ Metadata  │    Playlist     │
│ Provider │  Engine  │ Provider  │    Provider     │
│ (plugin) │ (plugin) │ (plugin)  │    (plugin)     │
└──────────┴──────────┴───────────┴─────────────────┘
```

Core resolution flow: a `LogicalTrack` carries `sources[]`, each a `SourceRef`.
The configured policy (an ordered rule list, e.g. `[{ kind: 'local' },
{ kind: 'streaming' }]`) decides which source to try first. A matching
`SourceProvider` turns that ref into a `ResolvedSource`, and the first
`PlaybackEngine` that reports `canPlay()` plays it.

Full design rationale lives in [`docs/superpowers/specs`](docs/superpowers/specs).

## Packages

Plugin packages live under `packages/plugins/<platform>/<name>`, where
`platform` is `any` (works identically everywhere — no environment-specific
API), `web` (a browser/DOM API, but that includes Electron and, eventually,
Capacitor — anything embedding a browser engine), or `desktop` (a real Node
API such as `node:fs`, currently the only platform with that need). Shared,
non-plugin code lives under `packages/shared/*`. A host (an Electron app, a
future web build, a future mobile shell) composes its own plugin set by
importing from whichever of these it needs — see
[`apps/electron-demo/plugins.js`](apps/electron-demo/plugins.js) for the
first such manifest.

| Package | Description |
| --- | --- |
| [`@unitrack/core`](packages/core) | The headless player: queue, resolver, plugin registry, playback orchestration. Platform-agnostic — no Node or DOM APIs. |
| [`@unitrack/conformance-kit`](packages/shared/conformance-kit) | Framework-agnostic assertion functions (`assertSourceProviderConformance`, etc.) that check a plugin instance against its contract — runnable under `node --test`, a headless-browser harness, or an in-app self-check screen. |
| [`@unitrack/util-fs`](packages/shared/util-fs) | Small filesystem-path helpers (`titleFromFilename`) shared by the `desktop`-tier plugins. Node-only. |
| [`@unitrack/source-local-fs`](packages/plugins/desktop/source-local-fs) | `SourceProvider` for local files. Resolves a filesystem path to a `file://` URL. Node-only. |
| [`@unitrack/playlist-local-fs`](packages/plugins/desktop/playlist-local-fs) | `PlaylistProvider` that scans a local folder for audio files. Node-only. |
| [`@unitrack/metadata-local-fs`](packages/plugins/desktop/metadata-local-fs) | `MetadataProvider` that reads tags (and cover art) from a local audio file via `music-metadata`. Node-only. |
| [`@unitrack/engine-web-audio`](packages/plugins/web/engine-web-audio) | `PlaybackEngine` built on a single `<audio>` element wired into a Web Audio graph. `lookaheadPlayback: false` — Core drives load/play directly. Browser/Electron. |
| [`@unitrack/engine-audio-queue`](packages/plugins/web/engine-audio-queue) | `PlaybackEngine` built on two chained `<audio>` elements, pre-buffering the next track for a gapless hand-off. `lookaheadPlayback: true` — accepts a revisioned `PlaybackPlan` via `setPlaybackPlan()`. Browser/Electron. |
| [`@unitrack/source-subsonic`](packages/plugins/any/source-subsonic) | `SourceProvider` for a self-hosted Subsonic-API server. Pure `fetch` + a dependency-free MD5 — no Node-specific API, works everywhere. |
| [`@unitrack/source-s3`](packages/plugins/any/source-s3) | `SourceProvider` for an S3-compatible object storage bucket (AWS S3, MinIO, ...). Pure `fetch` + Web Crypto SigV4 presigning — no Node-specific API, works everywhere. |
| [`@unitrack/electron-demo`](apps/electron-demo) | Minimal Electron host — the first end-to-end proof the pipeline produces audible sound. |
| [`@unitrack/web-demo`](apps/web-demo) | Minimal browser-only host — no Electron, no bundler. Plugins are served via an import map generated from each package's own `package.json.exports`. Proves the `any`/`web`-tier plugin set runs with zero Node APIs, and is the first host to register two networked `SourceProvider`s at once (a live `Resolver.js` policy-fallback demo). |

`@unitrack/core` deliberately depends on nothing at runtime except its own
`types.js` (`CONTRACT_VERSION`, the capability-key lists — real runtime
values, not just JSDoc types). Every plugin package imports that from
`@unitrack/core/types` and declares a matching `contractVersion`, checked by
`PluginRegistry` at registration time; beyond that, a plugin's contract stays
a plain duck-typed object.

## Getting started

Requires Node.js >= 18 (CI verifies 20 and 22).

```bash
npm install
```

Run the Electron demo — it opens a window with an "Open File" dialog and
play/pause/stop controls:

```bash
npm start -w @unitrack/electron-demo
```

Run the browser demo — a dev server on `http://localhost:8080` with forms
to connect a Subsonic server and/or an S3-compatible bucket:

```bash
npm start -w @unitrack/web-demo
```

## Development

```bash
npm test           # run every workspace's test suite
npm run typecheck  # tsc --checkJs --strict across all workspaces
```

Tests use Node's built-in test runner (`node --test`) with no test framework
dependency. Plugins are verified against hand-written stubs rather than a
mocking library — see `packages/plugins/web/engine-web-audio/test/helpers/domStubs.js`
for the DOM/Web Audio stand-in — and, where they overlap, against
`@unitrack/conformance-kit`'s shared assertion functions.

`@unitrack/electron-demo` has no automated tests by design: its entire purpose
is to verify audible output, which no stub can prove. It is checked manually.

## How this repository works

Each unit of work goes through a written cycle before any code is committed:

1. **Design spec** → `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` —
   what is being built, which alternatives were rejected and why, and an
   explicit non-goals section.
2. **Implementation plan** → `docs/superpowers/plans/YYYY-MM-DD-<topic>.md` —
   the step-by-step plan derived from the spec.
3. **Implementation** on a branch, merged via pull request.

Specs are the source of truth for *why* the code looks the way it does. When
behaviour and spec disagree, that is a bug in one of them — worth fixing
explicitly rather than silently.

Commit messages follow Conventional Commits (`feat:`, `fix:`, `chore:`,
`docs:`).
