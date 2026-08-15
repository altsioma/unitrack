# @unitrack/engine-web-audio — Design Spec

Date: 2026-08-15

## Purpose

The first concrete `PlaybackEngine` plugin for `@unitrack/core`, and the
package the original core design spec anticipated as the single MVP
playback engine (Web Audio-based, works across browser, Electron, and most
Tauri webviews without a native backend). It plays a `ResolvedSource`
(currently only produced by `@unitrack/source-local-fs`, which returns
`file://` URLs) via an `<audio>` element connected into a Web Audio graph,
satisfying `packages/core/src/types.js`'s `PlaybackEngine` contract.

## Scope

**In scope:** implementing the `PlaybackEngine` contract —
`canPlay`/`load`/`play`/`pause`/`stop`/`seek`/`getState`/`on`/
`getAudioGraphAnchor`.

**Explicitly out of scope:**
- Any EQ/DSP processing itself — `getAudioGraphAnchor()` only exposes the
  connection point; building anything that taps into it is separate future
  work.
- An `AudioBufferSourceNode`-based playback path (full-buffer decode) — the
  `MediaElementAudioSourceNode` approach (below) is the only one this
  package implements.
- Testing in a real browser as part of the automated suite — CI runs a
  from-scratch DOM/Web Audio stub in plain Node; real-browser verification
  is manual, via the `run` skill, separate from `npm test`.
- A universal engine-agnostic audio graph API — per the core's own design
  spec, deferred until a second, genuinely different engine exists.

## Architecture

**`MediaElementAudioSourceNode`, not `AudioBufferSourceNode`.** The engine
wraps an `<audio>` element (`new Audio()`), connected into the Web Audio
graph via `audioContext.createMediaElementSource(audioElement)`. Chosen
over decoding the full file into an `AudioBufferSourceNode` because:
- Progressive loading — doesn't require the whole file in memory before
  playback can start, which matters once streaming sources exist.
- `seek`/`pause`/`currentTime` are native `<audio>` element behavior, not
  something this package has to reimplement (an `AudioBufferSourceNode`
  has no built-in pause/resume-from-position; you'd have to track offsets
  and reschedule a fresh buffer source node yourself).
- `'ended'`/`'timeupdate'`/`'error'` are native media element events that
  map onto the `PlaybackEngine` contract's `'ended'`/`'progress'`/`'error'`
  almost 1:1.
- `getAudioGraphAnchor()` still works identically — the
  `MediaElementAudioSourceNode` is itself a valid Web Audio graph node that
  future EQ/DSP plugins can connect downstream of.

**Dependency injection for the Web Audio globals.** Unlike
`@unitrack/source-local-fs` (where `node:fs` is genuinely available in its
target runtime, Node), `Audio`/`AudioContext` don't exist in Node at all —
tests can't stub them without either global mutation (fragile, leaks
across tests) or injection. The factory accepts optional constructor
overrides:

```js
export function createWebAudioPlaybackEngine({
  AudioConstructor = globalThis.Audio,
  AudioContextConstructor = globalThis.AudioContext,
} = {}) { /* ... */ }
```

Called with no arguments in a real browser/Electron/Tauri host, it picks
up the real globals automatically; tests pass in stubs. This is a
deliberate departure from `createLocalFileSourceProvider()`'s
zero-argument factory — justified specifically because the underlying
platform API doesn't exist in the test runtime at all, not a general
precedent for every future plugin.

## Contract Implementation

- **`load(resolved)`** — sets `audio.src = resolved.url`, calls
  `audio.load()`, then waits for whichever of the native `'canplay'` or
  `'error'` events fires first. On `'error'`, rejects with an `Error`
  built from `audio.error` (a `MediaError`), mapping its numeric `.code`
  (1–4) to a readable message. This makes `load()` mean "the source is
  ready to play, or definitively won't be" — matching how
  `@unitrack/core`'s `CorePlayer` already treats a rejected `load()` (caught
  and surfaced via its own error-emission path, no special-casing needed
  on the core side).
- **`play`/`pause`/`stop`/`seek(seconds)`** — thin wrappers over
  `audio.play()`/`audio.pause()`/`audio.currentTime = seconds`. `stop()` is
  `pause()` followed by resetting `currentTime` to `0`.
- **`getState()`** — `{ position: audio.currentTime, duration: audio.duration || 0, buffering }`.
  `buffering` is a boolean flag toggled by the element's native `'waiting'`
  (true) and `'playing'` (false) events — not derived from `readyState`
  polling.
- **`on('progress', handler)`** — forwards the native `'timeupdate'` event
  with `{ position, duration }`. Not throttled at this layer — `CorePlayer`
  already throttles `positionChanged` on its side (250ms), so throttling
  here too would be redundant.
- **`on('ended', handler)` / `on('error', handler)`** — forward the native
  `'ended'`/`'error'` events (the latter with the same `MediaError`
  mapping used in `load()`).
- **`canPlay(resolved)`** — maps `resolved.format` (from
  `@unitrack/source-local-fs` or any future `SourceProvider`) to a MIME
  type via a small internal table (`mp3` → `audio/mpeg`, `flac` →
  `audio/flac`, `wav` → `audio/wav`, `ogg` → `audio/ogg`, `m4a`/`aac` →
  `audio/mp4`/`audio/aac`), then asks the browser's own
  `new Audio().canPlayType(mime)` rather than guessing. If `resolved.format`
  is absent or not in the table, `canPlay` returns `true` (permissive) —
  the table is a convenience, not authoritative, and rejecting an unmapped
  format risks false negatives on genuinely playable files this package
  simply didn't bother enumerating.
- **`getAudioGraphAnchor()`** — returns the `MediaElementAudioSourceNode`
  itself, the exact extension point the core's own design spec named for
  future EQ/DSP plugins.

## Package

```
packages/engine-web-audio/
├── package.json     — devDependencies: @unitrack/core, typescript (no @types/node)
├── tsconfig.json     — "lib": ["ES2022", "DOM"], no Node types
├── src/
│   └── index.js      — createWebAudioPlaybackEngine({ AudioConstructor?, AudioContextConstructor? })
└── test/
    ├── helpers/
    │   └── domStubs.js  — FakeAudioElement (extends EventTarget), minimal AudioContext stub
    └── index.test.js
```

## Testing

A from-scratch stub, `FakeAudioElement extends EventTarget`, exposing the
subset of `HTMLMediaElement` this package actually touches
(`currentTime`, `duration`, `paused`, `readyState`, `error`, `src`,
`play()`, `pause()`, `load()`), plus test-only helper methods to fire
`'canplay'`/`'error'`/`'ended'`/`'timeupdate'`/`'waiting'`/`'playing'` on
demand — the same "write a minimal dependency-free stand-in" approach
already used for `@unitrack/core`'s own `EventEmitter` (built from scratch
instead of `node:events`, for the same underlying reason: the real
platform primitive isn't guaranteed available everywhere this code runs).
Injected via `AudioConstructor`/`AudioContextConstructor`; no global
mutation.

This proves the engine's own logic (event wiring, state derivation, error
mapping, `canPlay` decision) is correct. It does not prove real browser
audio behavior — that's a manual/`run`-skill check, kept separate from
`npm test`.

## Non-goals

Restated from Scope: EQ/DSP implementation, an `AudioBufferSourceNode`
code path, automated real-browser testing, and a universal audio graph API
are all out of scope for this package.
