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

| Package | Description |
| --- | --- |
| [`@unitrack/core`](packages/core) | The headless player: queue, resolver, plugin registry, playback orchestration. Platform-agnostic — no Node or DOM APIs. |
| [`@unitrack/source-local-fs`](packages/source-local-fs) | `SourceProvider` for local files. Resolves a filesystem path to a `file://` URL. Node-only. |
| [`@unitrack/engine-web-audio`](packages/engine-web-audio) | `PlaybackEngine` built on an `<audio>` element wired into a Web Audio graph. Browser/Electron/Tauri. |
| [`@unitrack/electron-demo`](apps/electron-demo) | Minimal Electron host — the first end-to-end proof the pipeline produces audible sound. |

`@unitrack/core` deliberately depends on nothing. The plugin packages depend on
it only as a `devDependency`, for JSDoc types — their contracts are plain
duck-typed objects, so nothing is imported from the core at runtime.

## Getting started

Requires Node.js >= 18 (CI verifies 20 and 22).

```bash
npm install
```

Run the demo app — it opens a window with an "Open File" dialog and
play/pause/stop controls:

```bash
npm start -w @unitrack/electron-demo
```

## Development

```bash
npm test           # run every workspace's test suite
npm run typecheck  # tsc --checkJs --strict across all workspaces
```

Tests use Node's built-in test runner (`node --test`) with no test framework
dependency. Plugins are verified against hand-written stubs rather than a
mocking library — see `packages/engine-web-audio/test/helpers/domStubs.js` for
the DOM/Web Audio stand-in.

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
