# @unitrack/engine-audio-queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Status note:** like `2026-08-18-core-contract-v0.2.md`, this plan documents work that has already been implemented and verified (201 → 222 tests passing across the workspace, `tsc --checkJs` clean across all 9 packages) in a single continuous pass rather than task-by-task with intermediate commits. It is written retrospectively, after its own design-spec companion (`docs/superpowers/specs/2026-08-18-engine-audio-queue-design.md`).

**Goal:** Build `@unitrack/engine-audio-queue`, the first real `queueAuthority: 'engine'` `PlaybackEngine` implementation in this repo, and fix the two `CorePlayer` contract gaps its construction surfaced — as specified in `docs/superpowers/specs/2026-08-18-engine-audio-queue-design.md`.

**Architecture:** Two tasks. `CorePlayer`'s two fixes land first, since the new engine's own tests exercise the corrected `'ended'`-binding and repeat-one behavior. The new package's implementation and tests land second.

**Tech Stack:** Plain JavaScript (ESM) with JSDoc types checked via `tsc --checkJs`. Tests via Node's built-in `node:test` + `node:assert/strict`, against a from-scratch fake `<audio>` element (no jsdom or real browser dependency — same approach `@unitrack/engine-web-audio`'s tests already use). No new dependencies.

## Global Constraints

- `npm run typecheck` must report zero errors, and `npm test` must pass with pristine output, across every workspace package at the end of every task.
- `@unitrack/engine-audio-queue` starts at `0.1.0` (a new package, not a bump of an existing one) and depends on `@unitrack/core@^0.2.0`.
- No change to any other existing package's version — this is additive (a new package) plus two internal `CorePlayer.js` fixes that do not change `@unitrack/core`'s public contract shape, so `@unitrack/core` does not need another version bump for this change.

---

## Task 1: Fix the two `CorePlayer` gaps a real engine-owned engine surfaces

**Files:**
- Modify: `packages/core/src/CorePlayer.js`
- Modify: `packages/core/test/CorePlayer.test.js`

**Interfaces:**
- Consumes: nothing new — internal fixes to the existing `#bindEngine` and `#resolveLookaheadPlan` methods from the v0.2.0 work.
- Produces: no public API change. `'ended'` is now always bound in `#bindEngine`, not just for core-owned engines. `#resolveLookaheadPlan` now special-cases `repeat: 'one'`.

- [x] **Step 1: Bind `'ended'` unconditionally in `#bindEngine`**

Changed the `if (engine.capabilities.queueAuthority === 'engine') { engine.on('trackChanged', ...) } else { engine.on('ended', ...) }` branch into: bind `'ended'` → `#advanceOnEnded` unconditionally (moved out of the `if`/`else`), then a separate `if (engine.capabilities.queueAuthority === 'engine')` block that additionally binds `'trackChanged'` → `#reconcileEngineOwnedTrackChange`. See the design spec's Solution, Fix 1, for why this is safe — the plan is kept topped up as it's consumed, so `'ended'` firing on an engine-owned engine really does mean genuine end-of-plan, not "the plan just needs refreshing."

- [x] **Step 2: Special-case `repeat: 'one'` in `#resolveLookaheadPlan`**

Added an early return: when `this.queue.getRepeatMode() === 'one'`, the plan is padded with repeated copies of the current entry up to `DEFAULT_LOOKAHEAD_WINDOW`, skipping the normal forward-walk entirely. Extended the existing "known limitation" code comment to note the `repeat: 'all'` wrap-around gap explicitly (previously the comment only mentioned shuffle order) — see the design spec's Implementation Decision 2 for why `repeat: 'all'`'s wrap-around was documented rather than also fixed here.

- [x] **Step 3: Replace the now-incorrect `CorePlayer.test.js` test and add a `repeat: 'one'` test**

The existing test `'a queueAuthority: "engine" engine's "ended" event is ignored — Core waits for "trackChanged" instead'` asserted exactly the behavior Step 1 removes. Replaced with `'a queueAuthority: "engine" engine's genuine "ended" (no more plan to hand off to) advances the queue, same as a core-owned engine's does'`, which simulates the engine's `'ended'` and asserts `CorePlayer` advances to the next queue item via the normal path. Added `'repeat: "one" pads a queueAuthority: "engine" engine's lookahead plan with the current item instead of the actual next queue item'`, asserting every entry in the plan handed to a mock engine-owned engine has the same `queueItemId` as the current item when `repeat: 'one'` is active.

- [x] **Step 4: Run tests and typecheck for `@unitrack/core`**

Run: `npm test -w @unitrack/core` and `npm run typecheck -w @unitrack/core`.
Result: 123/123 passing (was 122 — net +1: one test replaced, one added, one redundant placeholder test from the replacement removed during review), zero typecheck errors.

---

## Task 2: Build `@unitrack/engine-audio-queue`

**Files:**
- Create: `packages/engine-audio-queue/package.json`
- Create: `packages/engine-audio-queue/tsconfig.json`
- Create: `packages/engine-audio-queue/src/index.js`
- Create: `packages/engine-audio-queue/test/index.test.js`
- Create: `packages/engine-audio-queue/test/helpers/domStubs.js`

**Interfaces:**
- Consumes: the `PlaybackEngine` contract from `@unitrack/core/types` (unchanged by this task — this package is a new *implementation* of the existing v0.2.0 contract, not a contract change).
- Produces: `createAudioQueuePlaybackEngine({ AudioConstructor })`, the package's sole export.

- [x] **Step 1: Scaffold the package**

`package.json` (name `@unitrack/engine-audio-queue`, version `0.1.0`, `@unitrack/core: ^0.2.0` devDependency, `test`/`typecheck` scripts matching every other plugin package's pattern exactly), `tsconfig.json` (identical to `@unitrack/engine-web-audio`'s — `allowJs`/`checkJs`, `ES2022`, `lib: ["ES2022", "DOM"]`).

- [x] **Step 2: Implement the two-slot chaining engine**

`src/index.js`: `makeSlot(id)` constructs one `<audio>` element and wires its `timeupdate`/`waiting`/`playing`/`error`/`ended` listeners once, each checking `slot === activeSlot` before forwarding (since `PlaybackEngine.on()` is only ever called once per event by `CorePlayer#bindEngine` — see the design spec's Solution). `loadIntoSlot(slot, entry)` sets `src`, calls `load()`, and awaits the same `canplay`/`error` race `@unitrack/engine-web-audio`'s `load()` uses (factored out here as `waitUntilPlayable(el)`). `prepareNextSlot()` pre-buffers `plan[1]` into the inactive slot, swallowing a load failure rather than propagating it (the current track is still fine). `handleActiveSlotEnded()` is the hand-off: swaps `activeSlot`/`inactiveSlot`, plays the newly-active slot, emits `'trackChanged'`, resets and re-arms the freed slot — or, if nothing is pre-buffered and ready, emits `'ended'` instead. The exported engine wires `capabilities`, `initialize`/`dispose`, `canPlay` (format/mime lookup, mirroring `engine-web-audio`), `load` (standalone, contract-completeness only), `setPlaybackPlan`, `play`/`pause`/`stop`/`seek` (all delegating to `activeSlot.el`), `getState`, `on`, `setVolume`/`getVolume` (applied to/read from as described in the design spec's Solution).

- [x] **Step 3: Build the two-instance-aware fake `<audio>` element test stub**

`test/helpers/domStubs.js`: `createFakeAudioConstructor()` returns a constructor function that creates a *fresh* fake element on every call (recording each on `.instances`, in creation order) — unlike `@unitrack/engine-web-audio`'s single-instance `asConstructor()` helper, which always returns the same instance. Needed because this engine constructs two independent `<audio>` elements at once and tests need to address each one (`AudioConstructor.instances[0]` / `[1]`) individually. Also exports `flush()` (a `setImmediate`-based microtask flush, matching the pattern `CorePlayer.test.js` already uses), needed to let `setPlaybackPlan()`'s sequential active-then-inactive slot loads interleave with a test's event simulations without deadlocking.

- [x] **Step 4: Write the test suite**

20 tests in `test/index.test.js`, covering capabilities, lifecycle, `setPlaybackPlan`'s two-slot loading behavior, the gapless hand-off path, the two "genuine end" paths (nothing pre-buffered; pre-buffer still in flight), post-hand-off slot re-arming, per-slot event forwarding, load-failure handling (including not double-reporting an in-flight load's own rejection as a second `'error'`), same-current-item `setPlaybackPlan` calls not reloading the active slot, `canPlay`, volume, transport delegation, `getState`, and standalone `load()`. See Testing Decisions in the design spec for the full list.

One test-authoring pitfall hit and fixed during this step: a test simulating "the active slot ends while the pre-buffer is still genuinely in flight" initially awaited the pre-buffer's load promise *before* triggering the simulated `'ended'`, which is a contradiction — awaiting it means it is no longer in flight. This produced `node:test`'s `'Promise resolution is still pending but the event loop has already resolved'` failure, cascading into every later test in the file being reported as `cancelledByParent`. Fixed by not awaiting `setPlaybackPlan()`'s overall promise before the simulated `'ended'` (since `play()` — called separately — does not depend on plan-resolution completing), then resolving the still-in-flight load at the very end of the test so it does not leave a truly dangling promise behind. A second, similar ordering mistake (awaiting a second `setPlaybackPlan()` call before simulating the second slot's `canplay`, rather than flushing first) was caught the same way and fixed with the same `flush()`-then-simulate-then-await pattern the rest of the suite already used.

- [x] **Step 5: Run tests and typecheck for the new package**

Run: `npm test -w @unitrack/engine-audio-queue` and `npm run typecheck -w @unitrack/engine-audio-queue`.
Result: 20/20 passing, zero typecheck errors.

- [x] **Step 6: Run the full workspace test suite and typecheck from the repo root**

Run: `npm test` and `npm run typecheck` from the repo root.
Result: 222/222 tests passing (123 `@unitrack/core`, 20 `@unitrack/engine-audio-queue`, 28 `engine-web-audio`, 12 `metadata-local-fs`, 13 `playlist-local-fs`, 10 `source-local-fs`, 11 `source-subsonic`, 5 `util-fs`), zero typecheck errors across all 9 workspace packages plus `apps/electron-demo`.

---

## Follow-ups not covered by this plan

- Wiring `@unitrack/engine-audio-queue` into `apps/electron-demo` (currently registers `@unitrack/engine-web-audio` only) — see the design spec's Out of Scope.
- The `repeat: 'all'` wrap-around and shuffle-order gaps in `#resolveLookaheadPlan`, both still documented known limitations, not fixed by this change — see the design spec's Implementation Decision 2.
- A `navigator.mediaSession`-integrated engine (OS lock-screen/notification transport controls) — a distinct, separately-scoped capability from `queueAuthority`.
- Any genuine background-playback engine requiring a native host project (e.g. an actual `AVQueuePlayer`-backed iOS engine) — this repository has no native host project to build one against yet.
- Committing this work and pushing/merging it — same pattern as `2026-08-18-core-contract-v0.2.md`: delivered into the working tree, left for manual `git add`/`commit` on the user's own machine.
