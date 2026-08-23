# electron-demo: networked source providers — plan

Derived from `docs/superpowers/specs/2026-08-20-electron-demo-networked-sources-design.md`.

## Task 1 — `package.json` + `plugins.js`

1. `apps/electron-demo/package.json`: add `@unitrack/source-subsonic`,
   `@unitrack/source-s3`, `@unitrack/source-direct-url` to `dependencies`,
   version-pinned the same way the existing entries are (`^0.2.0` /
   `^0.1.0`, matching each package's actual current version — check each
   package's own `package.json` before writing the range).
2. `apps/electron-demo/plugins.js`: import the three new factories, add
   three new `PLUGIN_MANIFEST` entries (`category: 'source'`,
   `process: 'preload'` for each), re-export the three factories.
3. `npm install` at the repo root (cloud mirror) to link the new workspace
   deps and regenerate `package-lock.json`.

## Task 2 — `index.html`

1. Copy the CSS rules `web-demo/index.template.html` uses for
   `fieldset`/`.row`/`.row label`/`.row input[type="text"/"password"]`
   into `electron-demo/index.html`'s existing `<style>` block (existing
   rules for `body`/`#seek,#volume`/`#queue-list*`/`#status` untouched).
2. Insert three `<fieldset>` blocks — Connect: Subsonic, Connect: S3, Add
   Track — copied verbatim (element IDs included) from
   `web-demo/index.template.html`, with the Add Track form's provider
   `<select>` options kept in the same 3-option shape (`subsonic`, `s3`,
   `direct-url`) web-demo uses. Positioned above the existing
   `Open File`/`Open Folder` row.

## Task 3 — `preload.mjs`

1. Import `createSubsonicSourceProvider`, `createS3SourceProvider`,
   `createDirectUrlSourceProvider` from `./plugins.js` alongside the
   existing three imports.
2. Add `requireSelectElement(id)` helper (copied from `web-demo/main.js`;
   `preload.mjs` doesn't have it yet since it has no `<select>` today).
3. Change `core.setPolicy([{ kind: 'local' }])` to `core.setPolicy([{}])`,
   carrying over the justification comment from `web-demo/main.js` adapted
   to mention Open File/Folder's `'local'`-kind sources explicitly (see
   spec's "Policy change" section).
4. Register `createDirectUrlSourceProvider()` unconditionally right after
   the existing `core.registerSourceProvider(createLocalFileSourceProvider())`
   call, logged via the existing `log()` (not `console.log`).
5. Add `subsonicRegistered`/`s3Registered` guard flags and the two
   connect-button click handlers, ported from `web-demo/main.js`'s
   `subsonic-connect`/`s3-connect` handlers, with `console.log`-style calls
   replaced by this file's `log(scope, message, detail)` and status text
   written to `#subsonic-status`/`#s3-status` exactly as web-demo does.
   Each handler calls the existing `core.initializePlugins(...)` re-run
   logic already inlined in this file (there is no separate
   `reinitializePlugins()` function here yet — factor the existing inline
   `await core.initializePlugins({...})` block, currently called once near
   the top, out into a `reinitializePlugins()` function so both the
   startup path and the two new connect handlers can call it, matching
   `web-demo/main.js`'s structure).
6. Add the Add Track form's click handler (`#add-track`), ported from
   `web-demo/main.js`, using this file's existing `core.enqueue(...)`
   pattern (already used by Open File/Open Folder) and its `kindFor`
   helper as scoped in the spec (3 branches, local to this handler).
7. No changes to Open File, Open Folder, transport buttons
   (prev/play/pause/stop/next), shuffle, repeat, seek, volume, queue
   reorder buttons, or any existing `log()` call site.

## Task 4 — README

1. `@unitrack/electron-demo` table row: extend the description to mention
   it now also registers the three networked source providers (mirror the
   wording style already used for `@unitrack/web-demo`'s row).
2. "Run the Electron demo" blurb: leave as-is (still accurate) unless
   Task 2/3 changed the window's very first interaction in a way that
   makes the current sentence misleading — check after implementation,
   edit only if needed.

## Task 5 — Verification

1. `npm test` (full workspace) — must stay green; no test files exist for
   `electron-demo` (unchanged) but this also re-runs every plugin
   package's own suite untouched by this work.
2. `npm run build:types && npm run typecheck` (full workspace).
3. Attempt a headless Electron launch (Xvfb, matching the approach used
   earlier in this project's v0.4 work) to confirm the window opens with
   no renderer-side exception, all seven fieldsets/forms are present in
   the DOM, and the IPC log stream shows `'core constructed'` /
   `'preload wiring complete'` reaching the terminal. If a full Electron
   launch isn't practical in this sandbox, fall back to: syntax/typecheck
   verification (already covered by step 2) plus a manual code-diff review
   confirming the ported blocks match web-demo's already-proven-live
   logic line-for-line aside from the noted `log()`/policy adaptations —
   and say so plainly in the report to the user rather than implying a
   live check happened.
4. Re-check `web-demo` needs nothing further: confirm (already true as of
   `b6f353a`) it registers all four providers and re-read its README row —
   no code change expected here, this step is a confirmation, not a task.

## Task 6 — Commit

1. Single commit, `feat(electron-demo): add source-subsonic, source-s3,
   source-direct-url with connection forms`, in the cloud mirror.
2. Sync the diff to the user's device repo using the established
   tar + `device_commit_files` + scratch-dir `cp -f` + manual
   `node_modules/@unitrack/*` symlink + git-lock-workaround pipeline (no
   new workspace packages this time, so no new symlinks should be needed —
   confirm during sync).
3. Verify final state on device (`npm test`, `npm run typecheck` if
   feasible without network — package-lock already regenerated in Task 1
   should make `npm ci`/`npm install` on device still fail per the
   established no-network limitation, so device-side verification is
   `node --test`/`tsc` invoked directly against the already-installed
   `node_modules`, same as prior syncs) and report completion, repeating
   the `_to_delete_*` manual-cleanup reminder.
