# electron-demo: networked source providers — design

## Purpose

`@unitrack/electron-demo` currently registers exactly one `SourceProvider`
(`source-local-fs`) plus `engine-web-audio`, `playlist-local-fs`, and
`metadata-local-fs`. `@unitrack/web-demo` has since proven, live, that
`source-subsonic`, `source-s3`, and `source-direct-url` all work as
drop-in `SourceProvider`s with zero Node-specific APIs — they are `any`-tier
packages precisely so that both a browser host and an Electron renderer can
use them unmodified.

This unit of work brings `electron-demo` to parity with `web-demo`: add the
same three networked providers, with the same connection-form /
Add-Track UI pattern, without regressing anything `electron-demo` already
does (Open File, Open Folder, prev/next, shuffle/repeat, queue reorder,
IPC-based logging to the main process).

The "и для web" half of the user's request is addressed by inspection: once
this spec's electron-demo changes are in, both hosts register the same four
`SourceProvider`s using the same package versions. No source change is
needed in `web-demo` itself — see Non-goals.

## Scope

- Add `@unitrack/source-subsonic`, `@unitrack/source-s3`,
  `@unitrack/source-direct-url` as dependencies of `electron-demo`.
- Extend `plugins.js`'s manifest and re-exports to include the three new
  factories.
- Extend `index.html` with three new `<fieldset>` blocks (Subsonic connect,
  S3 connect, Add Track), reusing `web-demo/index.template.html`'s markup
  and element IDs as-is where the DOM shape is identical, so the JS logic
  can be a near-direct port.
- Extend `preload.mjs` with: connect-button handlers that register a
  provider on click and call the existing plugin (re)initialization path;
  an Add Track form wired to `core.enqueueTrack`-equivalent (whatever the
  existing "add" path is, confirmed in the plan's research step) with a
  `kindFor(pluginId)` helper matching web-demo's 3-branch version, extended
  to also handle `local-fs` for tracks added via Open File/Folder; guard
  against double-registration exactly as web-demo does.
- Preserve every existing feature: Open File, Open Folder, full transport
  (prev/play/pause/stop/next), shuffle, repeat, seek, volume, queue reorder
  buttons (▲/▼/✕), synchronous IPC `log()`.
- Update `README.md`'s `@unitrack/electron-demo` row description if the
  one-line summary needs to mention the networked sources; update "Run the
  Electron demo" getting-started blurb only if it becomes materially wrong
  (it currently says "opens a window with an 'Open File' dialog and
  play/pause/stop controls", which stays true — additive, not replaced).

## Non-goals

- No change to `web-demo`'s own source files. It already has all four
  providers wired in (`source-direct-url` was added in the immediately
  prior unit of work). Parity is achieved from the electron-demo side only.
- No dedup of the connection-form logic into a shared package. Both hosts'
  "register a provider from form fields" glue is intentionally small
  (~15-20 lines per provider) and each host's event/logging conventions
  differ enough (plain `console.log` vs IPC `log()`) that extracting a
  shared helper would add an abstraction layer to save very little code.
  Revisit only if a third host appears.
- No change to `source-subsonic`/`source-s3`/`source-direct-url`
  themselves — they are already host-agnostic by design; nothing about
  Electron's renderer process requires special-casing (it is a Chromium
  page with `fetch` and `crypto.subtle`, same as `web-demo`).
- No Electron main-process (`node:fs`, IPC) involvement in the networked
  providers — they run entirely in the renderer via `preload.mjs`, exactly
  where `source-local-fs` already runs today (confirmed: `plugins.js`'s
  manifest tags `source-local-fs` as `process: 'main'`... — this needs
  verifying in the plan step, since `source-local-fs` is Node-only and the
  three new providers are not; see "Renderer vs main process" below).
- Not fixing the pre-existing `sources[0]?.sourceId` stale-field cosmetic
  logging bug at `preload.mjs` line 282 — out of scope, unrequested,
  logging-only, already flagged to the user as a deferred follow-up.

## Policy change (discovered while reading the current preload.mjs)

`preload.mjs` currently calls `core.setPolicy([{ kind: 'local' }])` — a
policy rule that matches only `SourceRef`s whose `kind` is `'local'` (the
one hard-coded kind `source-local-fs`'s registration path uses, per the
Open File/Open Folder handlers). `Resolver.resolveTrack()` filters
`track.sources` by rule before trying any provider; a `SourceRef` whose
`kind` doesn't match any rule is never even attempted, regardless of
whether a provider capable of resolving it is registered.

The three new providers' Add Track form (ported from web-demo) produces
sources of kind `'self-hosted'`, `'object-storage'`, `'direct-url'` — none
of which match `{ kind: 'local' }`. Left unchanged, tracks added via the
new form would fail to resolve at all (`TrackResolutionError`, "no source
matched policy"), independent of whether the providers themselves work.

This is fixed the same way `web-demo` already solved the identical
problem: replace the policy with a single catch-all rule, `core.setPolicy([{}])`,
matching every `SourceRef` in `LogicalTrack.sources` array order. This
preserves Open File/Open Folder's existing behaviour unchanged (a `'local'`
kind source still matches a catch-all rule; there is exactly one source per
locally-opened track today, so order doesn't change anything), while making
the Add Track form's primary/fallback ordering meaningful for the new
providers, exactly as it already is in web-demo. The same code comment
web-demo's `main.js` carries justifying catch-all over kind-first is carried
into `preload.mjs` at the call site.

## Renderer vs main process

Confirmed by reading the current `plugins.js`/`preload.mjs`:
`source-local-fs` itself already runs in the **preload** process (tagged
`process: 'preload'` in the manifest, constructed and registered directly
in `preload.mjs`) — Electron's preload context is a Node context, so
`node:fs`-dependent factory construction works there without an IPC hop.
Only *metadata tag reading* (`metadata-local-fs`, a separate, heavier
`node:fs` + parsing operation) is pushed to the **main** process via the
`fetch-metadata` IPC channel, for reasons unrelated to `SourceProvider`
registration itself.

`source-subsonic`, `source-s3`, `source-direct-url` need only `fetch` and
`crypto.subtle` — both available in the same preload context. They are
registered directly on the `CorePlayer` instance `preload.mjs` already
constructs, alongside `source-local-fs`, with no new IPC channel needed.
The manifest's `process` field for all three new entries reads `'preload'`.

## UI adaptation from web-demo

`web-demo/index.template.html`'s three fieldsets (`#subsonic-*`,
`#s3-*`, Add Track) are inserted into `electron-demo/index.html` verbatim
in terms of element IDs and structure, positioned above the existing Open
File/Open Folder row so the existing layout is purely appended-to, not
restructured. `electron-demo/index.html` has no `<style>` block currently
matching web-demo's fieldset/row styling — the relevant CSS rules
(`fieldset`, `.row`, `.row label`, `.row input[type="text"/"password"]`)
are copied in so the new forms render sanely; existing styling for
transport/status/queue is left untouched.

`preload.mjs`'s connect-button handlers mirror `web-demo/main.js`'s
pattern (`registerSubsonic()`, `registerS3()`, guard flags
`subsonicRegistered`/`s3Registered`, `reinitializePlugins()` calling
`core.initializePlugins(hostContext)` — confirmed safe to call repeatedly
per `CorePlayer.initializePlugins`'s source), but call the existing
IPC-based `log(scope, message, detail)` instead of `console.log`, matching
every other log call already in the file.

`direct-url` needs no connect step (matches web-demo: registered
unconditionally at startup, no form). `preload.mjs` registers
`createDirectUrlSourceProvider()` at module init alongside its other
always-on providers.

Confirmed by reading `preload.mjs`: Open File/Open Folder build their
`SourceRef`s directly and independently (`kind: 'local'`, hard-coded inline
at the `core.enqueue()` call sites) — they never go through a shared
`kindFor` helper today, and this work does not change that. The Add
Track form's `kindFor(pluginId)` helper is therefore a direct port of
web-demo's 3-branch version (`subsonic` → `'self-hosted'`, `s3` →
`'object-storage'`, else → `'direct-url'`), used only by the new form.

## Testing

Same approach as `electron-demo`'s existing precedent (no automated tests
— audible-output verification is manual) plus the same headless-Xvfb
launch-and-screenshot verification used earlier in this project's v0.4
work, extended to: fill each new connect form, click connect, confirm no
uncaught renderer exceptions (via the same console/pageerror capture
pattern used for `web-demo`'s Playwright checks, adapted to an Electron
window if feasible in this sandbox, otherwise a manual code-review +
`typecheck` + `npm test`-across-workspace pass, clearly noted as the
verification ceiling if a real display can't be launched here).

## Non-goals (repeated for emphasis)

- No new automated test suite for electron-demo (matches existing,
  documented convention).
- No visual polish beyond matching web-demo's existing minimal styling.
