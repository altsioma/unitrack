# @unitrack/electron-demo — Queue, Seek, Volume, Shuffle/Repeat UI — Design Spec

Date: 2026-08-17

## Problem Statement

`apps/electron-demo` still matches its original minimal scope: a single
"Open File" button that clears the queue and plays exactly one track, with
no progress bar, no volume control, and no way to see or manipulate the
queue at all. Meanwhile `@unitrack/core` has grown a real queue
(`add`/`remove`/`reorder`/`next`/`prev`), shuffle/repeat, and volume — none
of which the demo exposes. `@unitrack/playlist-local-fs` and
`@unitrack/metadata-local-fs` also exist and are fully tested, but nothing
in this monorepo has ever wired them into a running host; the demo is
still `source-local-fs` + `engine-web-audio` only. This is the last piece
of Направление B: turning the demo into an actual, usable local player.

## User Stories

1. As a listener, I want to open a whole folder of music at once (not one
   file at a time), so I don't have to add tracks one by one.
2. As a listener, I want tracks opened from a folder to show their real
   artist/title tags (not just the filename), so the queue is readable.
3. As a listener, I want to see the current queue as a list, so I know
   what's playing next.
4. As a listener, I want to click any track in the queue to jump straight
   to it, so I don't have to skip through everything before it.
5. As a listener, I want to remove a track from the queue, so I can drop
   something I don't want to hear without clearing everything.
6. As a listener, I want to reorder tracks in the queue, so I can fix the
   listening order without rebuilding it from scratch.
7. As a listener, I want Next/Previous buttons, so I can skip tracks
   manually.
8. As a listener, I want a progress bar that fills as the track plays and
   that I can drag to seek, so I can jump to any point in a track.
9. As a listener, I want a volume slider, so I can control loudness from
   inside the app.
10. As a listener, I want a shuffle toggle, so playback order can be
    randomized.
11. As a listener, I want a repeat control (off/all/one), so I can loop the
    queue or a single track.
12. As a listener, I still want to add a single file without building a
    whole folder playlist, so quick one-off playback stays easy.
13. As a listener, if a file in an opened folder has unreadable/corrupt
    tags, I want that one track to still show up in the queue (with a
    filename-based title) rather than the whole folder-open failing.
14. As a listener, I want errors (missing device, unreadable file, etc.)
    to stay visible in the UI, so I know when something went wrong instead
    of silence with no explanation.

## Solution

### Open Folder (new) and Open File (kept)

A new **"Open Folder"** button invokes a new `'open-folder-dialog'` IPC
handler (`dialog.showOpenDialog({ properties: ['openDirectory'] })` in
`main.js`, mirroring the existing file dialog). The chosen path is passed
to `createLocalFolderPlaylistProvider().fetchPlaylist({ pluginId:
'local-fs', playlistId: folderPath })`, which returns `LogicalTrack[]`
with filename-derived placeholder metadata. Each track's metadata is then
enriched via `createLocalFileMetadataProvider().fetchForSource(track.sources[0])`
run in parallel (`Promise.all`, folders are local disk reads, no network),
overwriting the placeholder `artist`/`album`/`title`/`duration`/
`coverArtUrl` with real tag data — falling back to the placeholder for any
single track whose tag read throws, per story 13. The resulting tracks are
added to the queue.

The existing **"Open File"** button keeps using `source-local-fs`-only
metadata (filename as title) — it stays a quick single-track add, no tag
reading, since a single file doesn't need a playlist provider at all.

### Queue list

A new `<ul id="queue-list">` renders one row per `core.queue.getItems()`
entry: title — artist, highlighted if it's `getCurrentIndex()`, with a
"remove" button (`core.queue.remove(queueItemId)`) and ▲/▼ buttons that
call `core.queue.reorder(queueItemId, newIndex)` to move the item one slot
up/down. Clicking a row's title calls `core.queue.setCurrentIndex(index)`
then `core.play()`. The list re-renders on `core.on('queueChanged', ...)`
and `core.on('trackChanged', ...)` (for the highlight).

### Next/Prev, seek, volume, shuffle/repeat

- Next/Prev buttons call `core.next()`/`core.prev()` directly (both
  already exist on `CorePlayer`).
- A `<input type="range">` progress slider's `max` is set to `duration`
  and its `value` to `position` on every `core.on('positionChanged', ...)`
  — except while the user has the mouse/pointer down on the slider (a
  `scrubbing` flag suppresses external updates during a drag, otherwise
  the slider fights the user's own drag). On `change` (drag released),
  calls `core.seek(slider.value)`.
- A `<input type="range" min="0" max="1" step="0.01">` volume slider calls
  `core.setVolume(value)` on `input`, initialized from `core.getVolume()`
  on load.
- A shuffle `<button>` toggles `core.queue.setShuffle(!core.queue.isShuffleEnabled())`
  and reflects state (`isShuffleEnabled()`) in its label/pressed state.
- A repeat `<button>` cycles `'off' → 'all' → 'one' → 'off'` via
  `core.queue.setRepeatMode(...)`, label shows the current mode from
  `core.queue.getRepeatMode()`.

## Implementation Decisions (confirmed)

1. **Opening a file or folder appends to the current queue**, not
   replaces it — a genuine behavior change from today's "Open File always
   clears the queue first." `core.queue.add(...)` without a preceding
   `clear()`.
2. **Reorder via ▲/▼ move-one-slot buttons per row, not drag-and-drop.**
3. **Repeat is a single cycling button (off → all → one → off).**
4. **No automated tests** — see Testing Decisions.

## Testing Decisions

No automated tests. Keeps the original electron-demo spec's precedent —
this package has never had tests, and that precedent is kept as-is here
too, including for the two pure-logic bits (`formatTime`, metadata-merge
fallback) that were flagged as extractable. Verification is manual: the
user runs the app and smoke-tests folder open, queue interactions, seek,
volume, and shuffle/repeat themselves (Claude cannot see or interact with
the running Electron window from this environment). `npm run typecheck`
still applies, same as every other package.

## Out of Scope

- **Drag-and-drop queue reordering.** See Implementation Decision 2.
- **Persisting `CoreState` to disk across app restarts** (i.e. actually
  calling `getState()`/`restoreState()` against a saved file on quit/
  launch). `restoreState()` exists and is fully tested at the `@unitrack/core`
  level, but no host in this monorepo has ever wired it to disk — that's
  a separate, self-contained piece of work or a future spec.
- **`@unitrack/source-subsonic` wiring.** Still deferred pending a real
  Subsonic server to verify against, per earlier decisions this session —
  this spec is local-fs-only, same as the rest of Направление B so far.
- **Cover art display.** `metadata-local-fs` already returns
  `coverArtUrl` and this spec enriches tracks with it, but rendering an
  `<img>` for it in the queue/now-playing UI is a follow-up visual
  polish item, not required for any user story above.
- **Packaging/distribution, keyboard shortcuts, drag-to-reorder via mouse
  drag, mobile/responsive layout.** None requested; consistent with the
  "minimal demo" framing of every prior electron-demo decision.

## Further Notes

`playlist-local-fs` and `metadata-local-fs` are Node-only (real `fs`
reads) and have no browser/DOM dependency, so — same as
`source-local-fs` today — they're imported and constructed directly in
`preload.mjs`, no new IPC channel needed for them (only the folder *picker
dialog* itself needs IPC, for the same `dialog.showOpenDialog` reason the
file picker already does).

## Post-review amendments (2026-08-17)

`/code-review` was run against this diff (fixed point: `feat/volume`).
Two real findings led to changes:

- **`trackChanged` now also calls `renderQueue()`.** The Solution section
  above says the queue list re-renders on both `queueChanged` and
  `trackChanged` "(for the highlight)"; the first implementation only
  wired `queueChanged`. It happened to still work (every path that moves
  `currentIndex` also emits `queueChanged`), but that's an invariant, not
  a guarantee — wiring `trackChanged` too matches the spec text literally
  and removes the fragility.
- **Undocumented decision, now documented: opening a file/folder only
  auto-plays if the player is currently `idle`** (`maybeAutoPlay()`;
  superseded 2026-08-18 — auto-play is now off by default and
  config-gated, see "Config" below),
  not unconditionally as the original single-file "Open File" behavior
  did. This was an implicit call made during implementation, not
  surfaced as an Implementation Decision at spec time — flagged by
  review as scope creep relative to the spec text, correctly. Recording
  it now: given Implementation Decision 1 (open appends rather than
  replaces the queue), unconditional autoplay would interrupt whatever
  is already playing every time a file/folder is opened, which
  contradicts the whole point of appending. Auto-playing only when idle
  preserves "opening your first file/folder just starts playing" while
  not stealing focus from an in-progress queue.

One Spec-axis finding was investigated and rejected: a claim that
`CorePlayer.setVolume/getVolume`, `QueueManager.setShuffle/isShuffleEnabled/
setRepeatMode/getRepeatMode`, and the `@unitrack/playlist-local-fs`/
`@unitrack/metadata-local-fs` packages "don't exist in this repo." This is
false — verified directly against the actual repo (`npm run typecheck` and
`npm run test --workspaces` both pass, including dedicated tests for every
API named). The reviewing sub-agent went off-script and explored the
filesystem itself instead of relying on the diff/spec text handed to it,
landing on a stale or wrong path. Noted here as a repeat of the
review-tooling pitfall from the volume spec's own review (there: an
incomplete prompt; here: a sub-agent ignoring the provided diff/spec in
favor of unreliable self-directed exploration) — not a real code issue.

## Post-ship fixes from manual testing (2026-08-18)

Manual testing surfaced two real bugs:

1. **Clicking a different queue item while a track was already
   playing/paused did nothing** (it only worked after `stop()`, or
   naturally on the `'ended'` auto-advance). Root cause was in
   `@unitrack/core`, not this app: `CorePlayer#play()` treated `#status
   === 'playing'` as "nothing to do" and `#status === 'paused'` as
   "just resume the active engine," without checking whether
   `queue.getCurrentItem()` still matched what was actually loaded
   (`#loadedQueueItemId`). `queue.setCurrentIndex()` moves the queue's
   pointer without itself touching playback (by design — see "a direct
   queue.setCurrentIndex() pointer jump does not interrupt playback" in
   `CorePlayer.test.js`), so a UI that calls `setCurrentIndex()` then
   `play()` — exactly what clicking a queue row does — hit this gap.
   `next()`/`prev()` never had this problem since they always call
   `#loadAndPlayCurrent()` unconditionally after moving. Fixed by having
   `#play()` compare the queue's current item against `#loadedQueueItemId`
   and always (re)load when they differ, regardless of `#status`. Three
   regression tests added to `CorePlayer.test.js` covering the
   already-playing case, the paused case, and a no-op guard (repeat
   `play()` with no queue-item change still does nothing, per existing
   behavior).
2. **Opening a folder could crash the app** rather than showing an error.
   Preload scripts run under Node, where — unlike a plain browser page —
   an unhandled promise rejection is fatal by default (it terminates the
   process instead of just logging). Every awaited call in the
   open-folder path was already wrapped in try/catch, but as a safety net
   against any error shape that isn't (now or in a future change), a
   `process.on('unhandledRejection', ...)` and `window.addEventListener('error', ...)`
   handler were added, both routing into the existing
   `lastErrorText`/status-line mechanism instead of letting the renderer
   go down silently. Separately, the metadata-enrichment step was changed
   from an unbounded `Promise.all` over every file in the folder to a
   concurrency-capped fetch (8 at a time via a small
   `mapWithConcurrencyLimit` helper) — a large folder previously fired off
   as many concurrent `parseFile()` calls (each opening a file handle) as
   there were files, risking `EMFILE` on big libraries. Exact root cause
   of the observed crash wasn't confirmed against a captured stack
   trace/crash log, so this is defense-in-depth against the whole class of
   "something escapes a try/catch and takes the renderer down" rather
   than a single pinpointed fix — flagged here rather than claimed as a
   definitively verified fix.

## Folder-open crash: FIRST HYPOTHESIS, WRONG — superseded below (2026-08-18)

The `render-process-gone` diagnostic added above pinned it down:
`{ reason: 'crashed', exitCode: 5 }` on macOS. That exact signature
(`reason: 'crashed'` + `exitCode: 5` on macOS) matches a known,
closed-as-not-planned Electron bug
([electron/electron#40426](https://github.com/electron/electron/issues/40426)):
when the renderer's V8 heap actually runs out of memory
("`V8 javascript OOM (Committing semi space failed.)`"),
`render-process-gone` misreports `reason: 'crashed'` instead of the
correct `'oom'` — so this was a real out-of-memory crash, not an
uncaught JS error (which is why the `unhandledRejection`/`error` safety
net added earlier didn't catch it — a V8 OOM kills the process before
any JS handler can run).

The actual memory driver: `coverArtUrl` (a base64 `data:` URL, up to a
few MB per track for embedded album art) was being merged into every
track's stored metadata during Open Folder, even though nothing in this
app renders it (see Out of Scope: "Cover art display"). For a folder
with many tracks carrying embedded art, that's the full image data for
every track held in the queue simultaneously, unused — enough to
exhaust the renderer's V8 heap on a large-enough folder. Fixed by
dropping `coverArtUrl` from the metadata actually stored (destructured
out before merging); `@unitrack/metadata-local-fs` itself is unchanged
and still returns it, since other, non-demo hosts may want it.

The earlier `mapWithConcurrencyLimit` and `unhandledRejection`/`error`
safety net (previous amendment) are still worth keeping — they guard
against transient fd/memory spikes and any future uncaught JS error
respectively — but neither was the actual cause here.


## Folder-open crash: actual root cause, reproduced and fixed (2026-08-18)

The two hypotheses above (V8 OOM from `coverArtUrl`; unbounded
concurrency) were both **wrong**. Recorded here rather than deleted,
because the reasoning that produced them — pattern-matching a crash
signature to a known bug report without reproducing it — is the mistake
worth remembering.

**How it was actually found.** Step-by-step synchronous logging through
the Open Folder path showed the renderer dying inside
`metadataProvider.fetchForSource()`, with no `tags OK`/`tags FAILED`
following. Serializing tag reads (concurrency 1) moved the crash to the
*first* file, ruling out concurrency. The same file parsed fine outside
Electron under both Node 20 (Electron 31's Node) and Node 22, ruling out
the file and the library version.

The crash was then **reproduced standalone** — Electron 31.7.7 + a
minimal main/preload pair — and bisected:

- `parseFile(...)` → renderer crash
- `parseBuffer(...)` (file read separately, buffer handed in) → crash
- `await import('strtok3')` → crash
- **`await import('node:path')` → crash**

So the trigger is **any dynamic `import()` inside an ESM preload script**
in Electron 31's renderer — not `music-metadata`, not any audio file, not
memory. `music-metadata` only trips it because it lazily `import()`s its
per-format parser. The failure surfaces as
`render-process-gone { reason: 'crashed', exitCode: 5 }` with no
catchable JS exception, which is why the earlier `unhandledRejection` /
`window.onerror` safety net never fired. The same
`music-metadata` calls run **fine in the main process** (verified,
including Cyrillic tags).

**Fix.** Tag reading moves to the main process behind a `fetch-metadata`
IPC handler, mirroring how the file/folder dialogs already work; the
renderer no longer imports `@unitrack/metadata-local-fs` at all. Verified
end-to-end in the standalone reproduction: renderer survives, tags
(including Cyrillic) come back intact. `@unitrack/metadata-local-fs`
itself is unchanged — it was never at fault.

Notes:

- `@unitrack/playlist-local-fs` **stays in the renderer**: it uses plain
  `node:fs/promises` with no dynamic import, and was verified working
  there. Every other first-party package was grepped for dynamic
  `import()` — none uses it, so nothing else is exposed to this.
- `coverArtUrl` is still dropped, now in the main process before it
  crosses IPC. The justification is no longer the (incorrect) OOM claim,
  just that nothing renders it and there's no reason to serialize
  megabytes per track.
- Concurrency-capped enrichment (8 at a time) is kept as sensible
  hygiene, not as a fix.
- A longer-term alternative is upgrading Electron (31 is well behind
  current). Not attempted here — a major-version Electron upgrade is its
  own piece of work, and the IPC split is the better architecture
  regardless, since it keeps Node-side plugins out of the renderer.

## Logging (convention for this app, 2026-08-18)

**`apps/electron-demo` logs verbosely and unconditionally.** This is a
deliberate standing rule for this package, not leftover debug scaffolding
to be cleaned up later.

Why: this app is development-only (`electron .`, never packaged, no
automated tests by design) and it is the only place where `@unitrack`'s
packages run inside a real host. It is therefore both the place where
integration bugs actually surface and the place with the least automated
signal. The folder-open crash took several diagnostic rounds — each one
costing a manual run by the user — almost entirely because the terminal
was silent and every round had to add logging back in. The rule that
came out of that: **anything worth knowing during a crash must already be
in the log before the crash happens.**

What is logged:

- *Main process* — startup with Electron/Chrome/Node/platform versions,
  window lifecycle (`dom-ready`, `did-finish-load`, `did-fail-load`,
  `preload-error`, `unresponsive`/`responsive`, `destroyed`),
  `render-process-gone` and `child-process-gone` with full details,
  `uncaughtException`/`unhandledRejection`, and every IPC call with its
  arguments, outcome and duration (via a `handleWithLogging` wrapper, so
  handlers don't each repeat it).
- *Renderer* — preload start and "wiring complete", every UI interaction
  (each button, queue-row click, reorder, remove, seek, volume,
  shuffle/repeat), every `CorePlayer` event (`stateChanged`,
  `trackChanged`, `queueChanged`, `error`), each step of Open File/Open
  Folder including scan timing and per-file tag failures, and
  `unhandledRejection`/`window.onerror`.

Two rules keep it usable rather than merely loud:

1. **Renderer logs go over a synchronous IPC channel** (`renderer-log`
   via `sendSync`), not just `console.log`. `console.log` is mirrored to
   the terminal too (main listens to `console-message`), but
   asynchronously — a renderer that dies instantly loses exactly the
   final messages that matter. With `sendSync` the last line printed is
   reliably the last step the renderer reached. Verified against a real
   Electron run that the channel tolerates every payload shape used here,
   including `Error` instances and DOM nodes.
2. **High-frequency events are throttled, not logged raw.**
   `positionChanged` fires several times a second and is logged on a
   5-second heartbeat; the volume slider logs on `change` (drag released)
   rather than `input` (every pixel), while still *applying* volume on
   every `input`. State objects are summarized rather than dumped whole,
   since `CoreState` contains the entire queue.

When adding a feature to this app, add its logging in the same pass — a
new IPC channel goes through `handleWithLogging`, a new UI control logs
its interaction, a new async step logs entry and outcome.


## Config (2026-08-18)

**`apps/electron-demo/config.json`, read once at startup, with
`autoPlayOnOpen: false` as the default.** Opening a file or folder now
only appends to the queue and leaves playback alone; it starts playing
only if the config explicitly asks for it.

This supersedes the "auto-play when idle" behaviour recorded in the
post-review amendment above. That behaviour was already a compromise —
Implementation Decision 1 made opening *append* rather than replace, and
auto-starting on every append means the app grabs the speakers each time
you add something to a queue you were curating. Off by default is the
behaviour that actually matches "opening adds to my queue".

Shape and handling:

- Defaults live in `main.js` (`DEFAULT_CONFIG`); `config.json` is merged
  over them, so a partial file only overrides what it names.
- A missing, unreadable or malformed `config.json` is **not** an error —
  it logs the reason and falls back to the defaults, so the app always
  starts. Verified against a real Electron run for all four cases
  (`false`, `true`, corrupt file, missing file).
- The main process owns the file; the renderer reads the resolved config
  once over a synchronous `get-config` IPC channel, which keeps preload's
  startup wiring free of async config plumbing.
- `autoPlayOnOpen: true` still only starts an *idle* player — it never
  interrupts something already playing or resumes something the listener
  deliberately paused.
- **No UI toggle**, per sign-off: this stays a config-file setting, in
  keeping with the app's minimal control surface.
- **Deliberately one key.** Other tunables (metadata concurrency, window
  size) were left as constants rather than pre-emptively moved into the
  config, consistent with this repo's no-speculative-generality posture —
  they move there if and when someone actually wants to change them.

`config.json` is committed with the defaults rather than gitignored, so
the app works out of the box and the setting is discoverable. The
trade-off is that changing it locally shows up as a git diff; that seems
right for a real behavioural setting, but it is worth remembering given
this repo's existing friction with a permanently-dirty tracked file.
