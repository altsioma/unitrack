# npm Workspaces Monorepo Conversion — Design Spec

Date: 2026-08-15

## Purpose

Convert the repository from a single `@unitrack/core` package at the repo
root into an npm workspaces monorepo, in preparation for adding separate
plugin packages (a local filesystem Source Provider, a Web Audio Playback
Engine, and eventually a minimal Electron demo host) as their own future
work. The design spec's Packaging section already treats concrete plugins
as work separate from the core package — a local filesystem provider pulls
in Node's `fs`, a Web Audio engine depends on browser/DOM APIs, and neither
belongs inside `@unitrack/core`, which must stay platform-agnostic. This
conversion only establishes the workspace boundary; it does not create any
new package beyond moving the existing core.

## Scope

**In scope:**
- Convert the repo root into a private npm workspaces root.
- Move the existing `@unitrack/core` package (`src/`, `test/`,
  `tsconfig.json`, `package.json`) into `packages/core/`, unchanged in
  content.
- Root-level `test`/`typecheck` scripts that delegate to every workspace
  package via `npm run <script> --workspaces --if-present`.

**Explicitly out of scope** (separate future work, not addressed here):
- Creating `packages/source-local-fs`, `packages/engine-web-audio`, or
  `apps/electron-demo` — each gets its own brainstorm/design/plan cycle
  when its turn comes. No stub packages are scaffolded now.
- Any change to `@unitrack/core`'s own source, tests, or public API.

## Design

**Tool:** npm workspaces — already the project's package manager
(`package-lock.json`, `npm test`/`npm run typecheck` conventions), so no
new tooling or dependency is introduced.

**Layout:**

```
unitrack/
├── package.json          — new: private workspace root
├── packages/
│   └── core/
│       ├── package.json  — the existing @unitrack/core, content unchanged
│       ├── src/
│       ├── test/
│       └── tsconfig.json
├── docs/                 — unchanged, stays at the repo root
└── .gitignore            — unchanged (node_modules/ already matches at any depth)
```

**Root `package.json`:**

```json
{
  "name": "unitrack",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "test": "npm run test --workspaces --if-present",
    "typecheck": "npm run typecheck --workspaces --if-present"
  }
}
```

`--if-present` so a future workspace package without its own `test`/
`typecheck` script doesn't break the root-level command.

**Migration mechanics:**
- Move `src/`, `test/`, `tsconfig.json`, and `package.json` (unchanged
  content — it stays the `@unitrack/core` package manifest) into
  `packages/core/` via `git mv`, so git's rename detection can follow the
  history.
- Delete the existing root-level `package-lock.json` and regenerate it
  from the repo root after the move — npm workspaces restructures the
  lockfile to cover every workspace package, so the pre-conversion
  single-package lockfile doesn't carry over as-is.
- Create the new root `package.json` (above) from scratch.

**Verification:** `npm install` from the repo root, then `npm test` and
`npm run typecheck` from the repo root — both must delegate correctly into
`packages/core` and reproduce the pre-conversion result (73 tests passing,
zero typecheck errors).

## Non-goals

Restated from Scope: no new plugin packages or demo app are created as
part of this conversion.
