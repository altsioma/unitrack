# @unitrack/core — Queue shuffle/repeat — Design Spec

Date: 2026-08-16

## Problem Statement

`QueueManager` (`packages/core/src/Queue.js`) is a strictly linear queue:
`moveNext()`/`movePrevious()` walk `#currentIndex` up and down a plain
array, and `CorePlayer#advanceOnEnded` calls `moveNext()` on every natural
track end, stopping at the end of the array. Shuffle and repeat were
explicitly deferred from the very first `CorePlayer` spec —
`docs/superpowers/specs/2026-08-13-core-player-design.md` lists "Shuffle,
repeat, gapless playback" under Non-goals, and the linear queue is
described there as "Minimal linear queue for the MVP." `playlist-local-fs`'s
own spec later flagged the queue this unblocks: *"so the demo (and
`CorePlayer.queue`, and `QueueManager`'s not-yet-built shuffle/repeat) has
more than one track to actually exercise."*

Now that `@unitrack/playlist-local-fs` can turn a folder into a real
multi-track queue, the gap is directly in the way of the UI demo work
(Направление B) — a demo with more than one track wants shuffle/repeat
controls, and `CorePlayer` has nowhere to put that behavior except this
package.

## User Stories

1. As a listener playing a folder-derived queue, I want to turn on
   shuffle, so tracks after the current one play in a randomized order
   instead of the folder-scan order.
2. As a listener with shuffle on, I want the currently playing track to
   keep playing uninterrupted when I toggle shuffle on, so turning on
   shuffle doesn't abruptly cut off what I'm listening to.
3. As a listener, I want to turn shuffle back off without losing my place,
   so the current track keeps playing and only the *upcoming* order
   reverts to the queue's normal order.
4. As a listener, I want a repeat-off mode (today's default/only
   behavior), so playback simply stops when the queue ends.
5. As a listener, I want a repeat-all mode, so that when the queue ends it
   loops back to the start and keeps playing.
6. As a listener, I want a repeat-one mode, so the current track repeats
   indefinitely when it ends naturally, without me manually restarting it.
7. As a listener in repeat-one mode, I want pressing next/prev to still
   move me to a different track, so repeat-one only governs what happens
   when a track ends on its own, not my manual navigation.
8. As a listener, I want shuffle and repeat to be independent settings I
   can combine freely (e.g. shuffle + repeat-all for endless randomized
   playback of the whole queue).
9. As a listener, I want the visible queue order (`getItems()`) to stay
   stable regardless of shuffle mode, so reordering/removing a specific
   track by id keeps working predictably and the UI doesn't visually
   reshuffle every track's position out from under me.
10. As a listener navigating back with shuffle on, I want "previous" to
    take me to the track that was actually just playing before the
    current one — not a random track, and not some fixed shuffled
    ordering I never actually played through.
11. As a developer integrating `CorePlayer` into a host UI, I want
    `next()`/`prev()`/the auto-advance-on-ended behavior to transparently
    respect the current shuffle/repeat mode without the host reimplementing
    queue-order logic itself.
12. As a developer persisting/restoring player state via
    `getState()`/`restoreState()`, I want shuffle/repeat mode to survive a
    save/restore round-trip, so reloading a saved session doesn't silently
    reset the listener's settings back to off.

## Solution

All new state and logic lives in `QueueManager` — consistent with
`CorePlayer` already delegating queue-order questions
(`moveNext`/`movePrevious`/`getCurrentIndex`) to it rather than owning them
itself. `CorePlayer` only needs one small change: `#advanceOnEnded` (the
natural-end-of-track handler) must special-case repeat-one, since "replay
the same track" isn't a `QueueManager` traversal at all — it never moves
`#currentIndex`.

### New `QueueManager` API

```js
/** @typedef {'off' | 'all' | 'one'} RepeatMode */

setShuffle(enabled: boolean): void
isShuffleEnabled(): boolean

setRepeatMode(mode: RepeatMode): void
getRepeatMode(): RepeatMode
```

`getItems()`, `getCurrentIndex()`, and `getCurrentItem()` are unchanged in
meaning: they always describe the queue's **canonical** (insertion) order
and the currently-playing item's position within it — never a shuffled
view. Shuffle only changes what `moveNext()`/`movePrevious()` pick *next*,
not how the queue reports itself. This is what keeps `add`/`remove`/
`reorder` (which all operate by `queueItemId`, already canonical-order-
agnostic) working unchanged, and keeps `restoreState()`'s existing
"rebuild queue, then `setCurrentIndex(originalIndex)`" logic valid without
knowing anything about shuffle.

### Shuffle mechanism

A history-stack model (the same shape as browser back/forward), not a
precomputed shuffled permutation of the whole queue:

- `QueueManager` keeps `#shuffleHistory: number[]` — canonical indices, in
  the order they were actually played this shuffle session — and
  `#shuffleHistoryPos`, a pointer into it (mirrors `#currentIndex`'s job
  while shuffle is active).
- **Turning shuffle on** seeds `#shuffleHistory` with just the current
  item's canonical index (if a track is loaded) or starts empty. This is
  what makes story 2 true: nothing about the currently-playing track
  changes.
- **`moveNext()` while shuffled:**
  - If `#shuffleHistoryPos` is not at the end of `#shuffleHistory` (the
    listener went back earlier and hasn't diverged since), just advance
    the pointer — deterministic redo, no new randomness, same as a
    browser forward button.
  - Otherwise, pick uniformly at random from canonical indices not yet in
    `#shuffleHistory` (this queue's own not-yet-played remainder — not a
    coin-flip that can immediately repeat a track), append it to
    `#shuffleHistory`, advance the pointer.
  - If every index has been played (history covers the whole queue): with
    `repeatMode === 'all'`, reset `#shuffleHistory` to just the current
    index and pick a fresh random remainder (a new shuffle cycle); with
    `repeatMode === 'off'` or `'one'`, return `false` (stop) — same
    end-of-queue contract `moveNext()` already has today.
- **`movePrevious()` while shuffled:** move `#shuffleHistoryPos` back one
  slot in `#shuffleHistory` and use that canonical index. Returns `false`
  at the start of history, mirroring today's "false at the start of the
  queue" contract. This directly satisfies story 10 — "previous" is always
  a real prior play, never a new random pick.
- **Turning shuffle off** simply stops consulting `#shuffleHistory`;
  `moveNext()`/`movePrevious()` fall back to the existing linear
  `#currentIndex` walk, continuing from wherever the currently-playing
  item's canonical index already is (satisfies story 3 — nothing about
  the current track or `#currentIndex` needs to change when shuffle is
  toggled off, since `#currentIndex` was being kept in sync all along;
  see below).
- **`#currentIndex` stays authoritative at all times**, shuffled or not —
  every shuffle pick/history-navigation also updates `#currentIndex` to
  match, the same way `moveNext()`/`movePrevious()` already do today. This
  is what keeps `getCurrentItem()`/`getCurrentIndex()` meaningful
  regardless of shuffle state, and is what makes toggling shuffle
  literally free (no recomputation needed on toggle beyond seeding
  `#shuffleHistory`).
- **Queue mutations while shuffled** (`add`/`remove`/`reorder`): no
  special handling needed beyond what already exists. `remove()` already
  reindexes `#currentIndex` when an item before it is deleted (existing
  logic) — `#shuffleHistory` stores canonical indices, so a `remove()`
  that shifts indices around would desync it. Simplest correct fix:
  `remove()` and `reorder()` also drop `#shuffleHistory` back to just the
  current index (same as freshly turning shuffle on) whenever they fire,
  since a queue-shape change invalidates any "already played" bookkeeping
  anyway. `add()` needs no reset — new items just become eligible for
  future random picks, satisfying the natural expectation that adding a
  track to a shuffled queue makes it something you'll shuffle into later.

### Repeat mechanism

- `getRepeatMode()` defaults to `'off'` — today's only behavior, so this
  is non-breaking.
- **`'off'`**: `moveNext()` at the end returns `false` (today's behavior,
  unchanged).
- **`'all'`**: `moveNext()` at the end wraps to canonical index `0`
  (linear mode) or starts a fresh shuffle cycle (shuffle mode, described
  above) instead of returning `false`. `movePrevious()` does **not** wrap
  backward past the start in either mode — see Implementation Decision 1.
- **`'one'`**: does not change `moveNext()`/`movePrevious()` at all — a
  manual skip in repeat-one still moves to a genuinely different track
  (story 7). It only changes `CorePlayer#advanceOnEnded` (the handler for
  the engine's natural `'ended'` event): instead of calling
  `queue.moveNext()`, it re-loads and replays the *same* `queueItem`
  (`#loadAndPlayCurrent()` again, no queue traversal at all). This is the
  one piece of behavior that lives in `CorePlayer`, not `QueueManager`,
  because "replay what's already current" isn't a queue-traversal
  concept — `QueueManager` has no method for it and doesn't need one.

### `CoreState` / persistence

`shuffle: boolean` and `repeatMode: RepeatMode` are added to `CoreState`
(`packages/core/src/types.js`) and round-tripped by `getState()`/
`restoreState()`, defaulting to `false`/`'off'` when absent from an older
snapshot (backward compatible). `#shuffleHistory` itself is **not**
persisted — `restoreState()` re-seeds it fresh from the restored current
item, same as freshly toggling shuffle on. Losing exactly which tracks
were already played this shuffle cycle across a save/restore is a minor,
acceptable loss (worst case: a restored session's shuffle can replay a
track sooner than it "should" once per restore) — the mode setting itself
surviving is what stories 12 actually asked for.

## Implementation Decisions (need your sign-off)

1. **`repeat: 'all'` does not wrap `movePrevious()` backward past index 0
   / the start of shuffle history.** Pressing "previous" on the very first
   track (or the first entry in shuffle history) still returns `false` and
   does nothing, even in repeat-all. Matches the asymmetric convention
   real players use (Spotify, Apple Music, YouTube Music all auto-wrap
   forward at the end but don't wrap backward on manual "previous" at the
   start) — forward wrap serves continuous playback, backward wrap has no
   equivalent "keep playing" motivation and would just be surprising.
   Recommend confirming this over full symmetric wrap-both-directions.
2. **Repeat-one only affects the engine's natural `'ended'` auto-advance,
   never a manual `next()`/`prev()` call.** This is the near-universal
   convention across real players (confirmed against Spotify/Apple
   Music/YouTube Music behavior) and is what story 7 asks for. The
   alternative (repeat-one also blocking manual skip) would trap a
   listener on one track with no way to move on except turning repeat off
   first — recommend confirming the standard behavior.
3. **Shuffle mode is a history-stack (browser back/forward model,
   described above), not a precomputed full-queue permutation.** The
   alternative — shuffle the whole queue once into a fixed order and walk
   a pointer through it — is simpler to picture but fails story 2 (jumps
   away from whatever's currently playing when toggled on unless special-
   cased) and is harder to keep correct across `add()`/`remove()` mid-
   playback. Recommend confirming the history-stack design over a
   precomputed permutation.
4. **`shuffle`/`repeatMode` are added to `CoreState` and persist across
   `restoreState()`; the shuffle play-history itself is not persisted.**
   The alternative is leaving `CoreState` untouched and letting shuffle/
   repeat silently reset to off on every restore — recommend persisting
   the mode (small, additive change to `CoreState`) since silently
   discarding a listener's setting on reload reads as a bug, not a
   deliberate scope cut.

## Testing Decisions

Tests land in `packages/core/test/Queue.test.js` (shuffle/repeat mechanics
in isolation, extending the existing `QueueManager` suite) and
`packages/core/test/CorePlayer.test.js` (the repeat-one auto-advance
special case, since that lives in `CorePlayer`). Given `QueueManager`'s
shuffle pick is randomized, tests assert the invariants that must hold
regardless of the random draw, not exact sequences:

1. `setShuffle`/`isShuffleEnabled` round-trip; defaults to `false`.
2. `setRepeatMode`/`getRepeatMode` round-trip; defaults to `'off'`.
3. Turning shuffle on with a track already current does not change
   `getCurrentItem()`/`getCurrentIndex()`.
4. With shuffle on and N items, calling `moveNext()` N-1 times from the
   start visits every remaining canonical index exactly once (no repeats,
   full coverage) — asserted via a `Set` of visited indices, not an exact
   order.
5. With shuffle on, `movePrevious()` after one or more `moveNext()` calls
   returns to the exact same item that was current before the last
   `moveNext()` (real history, not a new random pick) — run repeatedly
   (many random seeds via multiple iterations) to guard against a flaky
   "got lucky" pass.
6. With shuffle on and `repeat: 'off'`, `moveNext()` returns `false` once
   every item has been visited once.
7. With shuffle on and `repeat: 'all'`, `moveNext()` after every item has
   been visited starts a new shuffle cycle instead of returning `false`
   (asserted by confirming it keeps succeeding well past the queue's
   length, e.g. `3 * items.length` successful calls in a row for a small
   fixed queue).
8. With shuffle off and `repeat: 'all'`, `moveNext()` at the last index
   wraps to index 0 instead of returning `false`.
9. With `repeat: 'all'` (shuffle on or off), `movePrevious()` at the
   start still returns `false` (no backward wrap) — covers Decision 1.
10. `remove()`/`reorder()` while shuffled don't leave `#shuffleHistory`
    referencing a stale/incorrect canonical index (covered indirectly: a
    `moveNext()`/`movePrevious()` immediately after a mutation still lands
    on a real, correct item — not asserting the internal reset mechanism
    directly, per this repo's "test through the public interface" TDD
    convention).
11. (`CorePlayer.test.js`) With `repeat: 'one'`, the engine's `'ended'`
    event reloads and replays the same `queueItem` — `trackChanged` is
    *not* re-emitted for a "new" track (still the same one), the source is
    re-resolved and the engine's `load()`/`play()` are called again, and
    `queue.getCurrentIndex()` is unchanged.
12. (`CorePlayer.test.js`) With `repeat: 'one'`, a manual `next()` still
    advances to a different track (repeat-one does not block manual
    navigation — covers story 7).
13. `getState()`/`restoreState()` round-trips `shuffle`/`repeatMode`.
14. `restoreState()` on a snapshot without `shuffle`/`repeatMode` fields
    (simulating an older persisted snapshot) defaults them to
    `false`/`'off'` rather than throwing or leaving them `undefined`.

## Out of Scope

- **Gapless playback.** Unrelated mechanism (audio-buffer-level
  scheduling in the playback engine), already a separate non-goal in the
  original `CorePlayer` spec.
- **A "shuffle history" that's visible/inspectable by the host** (e.g. an
  explicit "recently played" list). `#shuffleHistory` is a private
  implementation detail of the traversal algorithm, not a new public API
  surface — out of scope unless a real need shows up.
- **Weighted/smart shuffle** (avoiding recently-played artists/albums,
  etc.). Uniform random over the not-yet-played remainder only.
- **Any `apps/electron-demo` UI for these controls.** This spec is
  `@unitrack/core` only; wiring shuffle/repeat buttons into the demo is
  its own later piece of work (see Purpose in the earlier
  `metadata-local-fs`/`playlist-local-fs` specs' "package first, demo
  wiring later" sequencing, applied here too).
