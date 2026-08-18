# @unitrack/core / @unitrack/engine-web-audio — Volume — Design Spec

Date: 2026-08-17

## Problem Statement

Neither `PlaybackEngine` (`packages/core/src/types.js`) nor `CorePlayer`
nor `@unitrack/engine-web-audio` have any notion of volume — there's no
way for a host to turn playback up or down at all. This blocks the next
piece of Направление B (queue/seek/**volume** in the UI demo) and was
never in scope for any prior spec (`engine-web-audio`'s own spec lists
"Any EQ/DSP processing itself" as out of scope but says nothing about
volume, which is a distinct, much more basic capability).

## User Stories

1. As a listener, I want to adjust playback volume with a slider, so I
   can control loudness without touching my OS/system volume.
2. As a listener, I want my volume level to keep applying across track
   changes (manual skip, auto-advance, shuffle, repeat), so I don't have
   to re-set it after every track.
3. As a listener, I want my volume level to survive session save/restore,
   so reloading a saved session doesn't reset me back to full volume.
4. As a developer integrating a new `PlaybackEngine` implementation in the
   future, I want volume control to be part of the required contract
   (not an optional capability some engines skip), since it's a baseline
   feature every real audio backend supports.

## Solution

### `PlaybackEngine` contract addition

```js
/**
 * @property {(volume: number) => void} setVolume
 * @property {() => number} getVolume
 */
```

Added as **required** members of `PlaybackEngine`, not optional like
`getAudioGraphAnchor` (which is genuinely backend-specific — a future
non-Web-Audio engine might not expose a raw graph node at all, but every
realistic audio backend supports a volume/gain control, so there's no
reason to let engines skip this one).

`volume` is a linear `0` (silent) to `1` (full) number, matching
`HTMLMediaElement.volume`'s and `GainNode.gain.value`'s own convention —
a host UI mapping to a `0–100` slider just divides/multiplies by 100
itself; no reason for this contract to duplicate that unit choice.
`setVolume` **clamps** out-of-range input to `[0, 1]` rather than
throwing — see Implementation Decision 3.

### `@unitrack/engine-web-audio` implementation

A `GainNode` inserted into the existing Web Audio graph, between the
`MediaElementAudioSourceNode` and `audioContext.destination`:

```
sourceNode -> gainNode -> audioContext.destination
```

(today: `sourceNode -> audioContext.destination` directly).
`setVolume(volume)` sets `gainNode.gain.value`; `getVolume()` reads it
back. Default gain is `1` (full volume, matching today's implicit
"whatever `<audio>`'s default volume is" behavior — no behavior change
for a host that never calls `setVolume`).

**Why a `GainNode`, not `audio.volume`.** The simpler alternative — just
set the native `<audio>` element's own `.volume` property — needs no new
graph node at all. But this package's own spec explicitly built a real
Web Audio graph (`MediaElementAudioSourceNode`, not a bare `<audio>`
element) specifically so `getAudioGraphAnchor()` gives future EQ/DSP
plugins "a valid Web Audio graph node... to connect downstream of." A
`GainNode` is the idiomatic Web Audio way to do volume and keeps
everything audio-related inside that one graph, consistent with the
architecture this package already committed to — rather than volume
living as a side-channel property on the `<audio>` element while
everything else routes through the graph. It also sidesteps a real,
inconsistently-documented cross-browser quirk: some browser engines have
historically not reliably applied `<audio>.volume` once the element is
routed through `createMediaElementSource` (behavior has differed between
Chromium and WebKit at various points) — a `GainNode` has no such
ambiguity, it's just a standard node in the graph. See Implementation
Decision 1 for the alternative if you'd rather avoid the extra node.

`getAudioGraphAnchor()` continues to return the `MediaElementAudioSourceNode`
(unchanged) — a future EQ/DSP consumer connecting from the anchor would
run in parallel with the volume-controlled path unless it also knows to
route through/around the `GainNode`. This is an existing open question for
any future graph consumer regardless of volume (today's single direct
`sourceNode -> destination` connection has the exact same "how does a new
consumer not double up the signal" issue) — not something this spec needs
to resolve, since no DSP consumer exists yet.

### `CorePlayer`

```js
setVolume(volume: number): void
getVolume(): number
```

`CorePlayer` keeps `#volume` as its own persistent field (default `1`),
the same shape as `#policy` — state that must survive engine/track
changes, since `#activeEngine` is reassigned on every track load
(`#bindEngine`). Two things apply it:

- `setVolume(volume)` stores the clamped value and, if there's a live
  `#activeEngine`, calls `engine.setVolume(volume)` on it immediately —
  satisfies story 1 (an in-progress track's volume changes right away).
- `#bindEngine(engine)` calls `engine.setVolume(this.#volume)` whenever it
  binds an engine (including a freshly loaded one for a new track) —
  satisfies story 2 (a newly loaded track starts at the listener's
  already-chosen volume, not the engine's own default).

`volume: number` is added to `CoreState`
(`packages/core/src/types.js`) and round-tripped by `getState()`/
`restoreState()`, defaulting to `1` when absent from an older snapshot
(same backward-compatible pattern already used for `shuffle`/
`repeatMode`) — satisfies story 3.

## Implementation Decisions (need your sign-off)

1. **`GainNode` in the Web Audio graph, not the native `<audio>.volume`
   property.** Alternative: skip the new graph node entirely and just set
   `audio.volume = value` directly — simpler (no graph rewiring, no new
   stub needed in `domStubs.js`'s fake `AudioContext`), and would work
   fine in this demo's actual target runtime (Electron, i.e. Chromium,
   which does honor `<audio>.volume` post-routing). Recommend the
   `GainNode` anyway for the graph-consistency and cross-engine-quirk
   reasons above, but flagging since the simpler alternative is
   genuinely viable here, not just theoretically.
2. **`setVolume`/`getVolume` are required on every `PlaybackEngine`**,
   unlike `getAudioGraphAnchor` which stays optional. Alternative: make
   volume optional too, for maximum flexibility on hypothetical future
   engines. Recommend required — volume is a baseline capability, not a
   backend-specific extra, and `@unitrack/engine-web-audio` is currently
   the only implementation anyway so this costs nothing today.
3. **Out-of-range `setVolume` input is silently clamped to `[0, 1]`**,
   not rejected. This deliberately diverges from
   `HTMLMediaElement.volume`'s own setter, which throws
   `IndexSizeError` for values outside `[0, 1]` in real browsers.
   Recommend clamping — a host UI doing slider math (e.g. `value / 100`)
   can produce a value like `1.0000000000000002` from float rounding;
   throwing on that is fragile for no real benefit, and silently doing
   what the caller obviously meant (full volume) is friendlier. Compare
   `QueueManager.setCurrentIndex()`, which *does* throw `RangeError` for
   out-of-bounds input — that's a different situation (an out-of-bounds
   index is a programmer error pointing at a real bug, e.g. a stale
   index after a mutation), not a UI-driven continuous value.
4. **No separate mute/unmute concept — volume `0` is silence.** A host
   wanting a "mute" button remembers the pre-mute volume itself and calls
   `setVolume(0)` / `setVolume(rememberedVolume)`. Recommend not building
   mute as a first-class feature (extra state, extra contract surface) for
   something that's a two-line host-side pattern on top of what this spec
   already provides — matches the "no speculative generality" posture
   `shuffle`/`repeat`'s own spec used for weighted shuffle.
5. **`volume` is added to `CoreState` and persists across
   `restoreState()`**, same as `shuffle`/`repeatMode` were in the
   previous spec. Recommend yes for the same reason: silently resetting a
   listener's volume to full on every reload reads as a bug.

## Testing Decisions

Tests land in `packages/engine-web-audio/test/index.test.js` (the
`GainNode` mechanics, extending `domStubs.js`'s fake `AudioContext` with a
`createGain()` stub) and `packages/core/test/CorePlayer.test.js` (volume
persisting across track changes and round-tripping through
`getState()`/`restoreState()`).

1. (`engine-web-audio`) `getVolume()` defaults to `1` before any
   `setVolume()` call.
2. (`engine-web-audio`) `setVolume(0.5)` then `getVolume()` returns `0.5`,
   and the underlying fake `GainNode`'s `gain.value` reflects it.
3. (`engine-web-audio`) `setVolume()` clamps values above `1` to `1` and
   below `0` to `0`.
4. (`engine-web-audio`) the `GainNode` is wired between the
   `MediaElementAudioSourceNode` and `audioContext.destination` (not the
   source node connecting directly to the destination anymore) —
   asserted via the fake `AudioContext`/`GainNode` stubs' recorded
   `connect()` calls.
5. (`CorePlayer`) `getVolume()` defaults to `1`; `setVolume()` round-trips.
6. (`CorePlayer`) `setVolume()` while a track is actively loaded/playing
   calls the active engine's `setVolume()` immediately.
7. (`CorePlayer`) a volume set before playback starts is applied to the
   engine once a track actually loads (covers "set volume while idle,
   then hit play").
8. (`CorePlayer`) volume set on one track carries over and is re-applied
   when moving to the next track (`next()`/auto-advance/`prev()`) —
   covers story 2 directly, using the same mock-engine helper already
   used for shuffle/repeat's `CorePlayer` tests.
9. (`CorePlayer`) `getState()`/`restoreState()` round-trip `volume`.
10. (`CorePlayer`) `restoreState()` on a snapshot missing `volume`
    defaults it to `1` rather than throwing or leaving it `undefined`
    (same backward-compatibility pattern as `shuffle`/`repeatMode`).

## Out of Scope

- **Mute/unmute as a first-class concept.** See Implementation Decision 4.
- **Per-track or persisted-per-device volume normalization/ReplayGain.**
  Out of scope — a single global volume knob only.
- **Any EQ/DSP beyond the single `GainNode` this spec adds.** Still
  explicitly out of scope per `engine-web-audio`'s own original spec.
- **Any `apps/electron-demo` UI for a volume slider.** This spec is
  `@unitrack/core` + `@unitrack/engine-web-audio` only; wiring an actual
  slider into the demo is the next, separate piece of work (same
  "package/contract first, demo wiring later" sequencing already used for
  every other Направление B package).
