# npm Workspaces Monorepo Conversion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the repo root from a single `@unitrack/core` package into a private npm workspaces root with `@unitrack/core` moved to `packages/core/`, as specified in `docs/superpowers/specs/2026-08-15-npm-workspaces-monorepo-design.md`.

**Architecture:** No source code changes. `src/`, `test/`, `tsconfig.json`, and `package.json` (the existing `@unitrack/core` manifest, content unchanged) move as a unit into `packages/core/` via `git mv`. A new root `package.json` becomes the private workspace root, delegating `test`/`typecheck` to every workspace package.

**Tech Stack:** npm workspaces (no new dependency — npm is already the project's package manager).

## Global Constraints

- No change to `@unitrack/core`'s own source, tests, or public API — this is a pure directory/manifest restructuring.
- No new packages are created (`packages/source-local-fs`, `packages/engine-web-audio`, `apps/electron-demo` are explicitly out of scope — separate future work).
- `docs/` and `.gitignore` stay at the repo root, unchanged.
- After the move, `npm test` and `npm run typecheck` run from the repo root must both still work, delegating into `packages/core`, and must reproduce the pre-conversion result: 73 tests passing, zero typecheck errors.

---

## Task 1: Convert to npm workspaces and move @unitrack/core into packages/core

**Files:**
- Move: `src/` → `packages/core/src/`
- Move: `test/` → `packages/core/test/`
- Move: `tsconfig.json` → `packages/core/tsconfig.json`
- Move: `package.json` → `packages/core/package.json` (content unchanged)
- Delete: `package-lock.json` (regenerated at the new root after the move)
- Create: `package.json` (new root workspace manifest)

**Interfaces:**
- Consumes: nothing (pure restructuring of existing files; no code changes).
- Produces: a root `package.json` with `"workspaces": ["packages/*"]` and delegating `test`/`typecheck` scripts. `packages/core/package.json` remains the exact `@unitrack/core` manifest that existed before this task, at its new path.

- [ ] **Step 1: Verify a clean working tree before moving anything**

Run: `git status`
Expected: working tree clean (no uncommitted changes) other than possibly the untracked `skills-lock.json`, which is unrelated and must not be touched by this task.

- [ ] **Step 2: Create the `packages/core` directory and move the package into it**

Run these from the repo root, in order:

```bash
mkdir -p packages/core
git mv src packages/core/src
git mv test packages/core/test
git mv tsconfig.json packages/core/tsconfig.json
git mv package.json packages/core/package.json
```

- [ ] **Step 3: Verify the move**

Run: `ls packages/core` and `git status`
Expected: `packages/core` contains `src/`, `test/`, `tsconfig.json`, `package.json`. `git status` shows the four paths as renames (`renamed:` lines), not separate delete+add pairs — if git shows them as plain deletes and untracked adds instead of renames, that's fine too (git's rename detection is a display heuristic, not a guarantee), but confirm no content was lost by checking `git status` reports no unexpected modifications.

- [ ] **Step 4: Confirm `packages/core/package.json` content is unchanged**

Run: `git show HEAD:package.json` and compare against the current content of `packages/core/package.json`
Expected: identical — this task must not change the manifest's content, only its location.

- [ ] **Step 5: Remove the old lockfile**

```bash
git rm package-lock.json
```

- [ ] **Step 6: Create the new root `package.json`**

Create `package.json` at the repo root:

```json
{
  "name": "unitrack",
  "private": true,
  "workspaces": [
    "packages/*"
  ],
  "scripts": {
    "test": "npm run test --workspaces --if-present",
    "typecheck": "npm run typecheck --workspaces --if-present"
  }
}
```

- [ ] **Step 7: Install and regenerate the lockfile**

Run: `npm install` from the repo root.
Expected: succeeds, creates a new `package-lock.json` at the repo root covering the workspace, and creates/updates `node_modules` (including a symlink for `packages/core` under the workspace's `node_modules`, standard npm workspaces behavior).

- [ ] **Step 8: Verify tests pass through the delegated root script**

Run: `npm test` from the repo root.
Expected: delegates into `packages/core`, runs `node --test "test/**/*.test.js"` there, and reports 73 tests passing, 0 failing — identical to the pre-conversion result.

- [ ] **Step 9: Verify typecheck passes through the delegated root script**

Run: `npm run typecheck` from the repo root.
Expected: delegates into `packages/core`, runs `tsc -p tsconfig.json` there, zero errors.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json packages/core
git commit -m "chore: convert to npm workspaces, move @unitrack/core to packages/core"
```
