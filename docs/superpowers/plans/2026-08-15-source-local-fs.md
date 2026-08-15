# @unitrack/source-local-fs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@unitrack/source-local-fs` — a `SourceProvider` plugin for `@unitrack/core` that resolves a local filesystem path into a `file://` `ResolvedSource` — as specified in `docs/superpowers/specs/2026-08-15-source-local-fs-design.md`.

**Architecture:** A single new npm workspace package, `packages/source-local-fs/`, exporting one zero-argument factory function, `createLocalFileSourceProvider()`, that returns a plain object satisfying `@unitrack/core`'s `SourceProvider` contract. No runtime dependency on `@unitrack/core` — it's a devDependency used only for JSDoc type-checking.

**Tech Stack:** Plain JavaScript (ESM) with JSDoc types checked via `tsc --checkJs`. Tests via Node's built-in `node:test` + `node:assert/strict`, using real temporary files (no `fs` mocking). Zero runtime dependencies.

## Global Constraints

- Zero runtime dependencies. `@unitrack/core` and `typescript` are devDependencies only.
- `SourceRef.sourceId` for this provider is an absolute filesystem path; `ResolvedSource.url` is a `file://` URI built via `url.pathToFileURL`.
- `canResolve` is synchronous and touches only `ref.pluginId` — no filesystem access. `resolve` is where existence/readability is actually confirmed (via `fs.access(sourceId, constants.R_OK)`), and its rejection is left unwrapped — `@unitrack/core`'s `Resolver.js` already catches and records it.
- `format` is the lowercased file extension without the leading dot, included in the returned object only when present (never set to `undefined`). `bitrate` is never populated — explicitly out of scope.
- Out of scope for this plan (per spec Non-goals): directory scanning, `LogicalTrack`/playlist construction, ID3/metadata reading, bitrate detection, a full `CorePlayer` integration test.
- `npm run typecheck` and `npm test`, run from the repo root, must both pass cleanly (delegating into every workspace package, including this new one) at the end of the task.

---

## Task 1: Scaffold and implement @unitrack/source-local-fs

**Files:**
- Create: `packages/source-local-fs/package.json`
- Create: `packages/source-local-fs/tsconfig.json`
- Create: `packages/source-local-fs/src/index.js`
- Create: `packages/source-local-fs/test/index.test.js`

**Interfaces:**
- Consumes: `@unitrack/core`'s JSDoc types (`SourceRef`, `ResolvedSource`, `SourceProvider`) from `packages/core/src/types.js`, referenced via `import('@unitrack/core/types').X` — resolvable once `npm install` links the workspace. No runtime import from `@unitrack/core`.
- Produces: `export function createLocalFileSourceProvider(): SourceProvider` from `packages/source-local-fs/src/index.js`. This is the package's entire public surface.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@unitrack/source-local-fs",
  "version": "0.1.0",
  "description": "Local filesystem Source Provider plugin for @unitrack/core",
  "type": "module",
  "engines": {
    "node": ">=18"
  },
  "main": "src/index.js",
  "exports": "./src/index.js",
  "scripts": {
    "test": "node --test \"test/**/*.test.js\"",
    "typecheck": "tsc -p tsconfig.json"
  },
  "devDependencies": {
    "@types/node": "^18",
    "@unitrack/core": "^0.1.0",
    "typescript": "^5.5.4"
  }
}
```

`@types/node` is required here (and wasn't needed for `packages/core`) because `packages/core/src/` never imports a Node built-in module by design (the core stays platform-agnostic), while this package's `src/index.js` imports `node:fs/promises`/`node:url`/`node:path` directly — `tsc --checkJs` needs the type declarations to resolve those imports.

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "allowJs": true,
    "checkJs": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.js"]
}
```

- [ ] **Step 3: Install from the repo root**

Run (from the repo root, not from inside `packages/source-local-fs`): `npm install`
Expected: npm recognizes the new workspace package (the root `package.json`'s `"workspaces": ["packages/*"]` already covers it — no root change needed), links `node_modules/@unitrack/core` and `node_modules/@unitrack/source-local-fs` as workspace symlinks, and installs `typescript` for the new package.

- [ ] **Step 4: Write the failing tests**

`packages/source-local-fs/test/index.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLocalFileSourceProvider } from '../src/index.js';

test('has the local-fs id and kind', () => {
  const provider = createLocalFileSourceProvider();
  assert.equal(provider.id, 'local-fs');
  assert.equal(provider.kind, 'local');
});

test('canResolve returns true only for refs targeting this plugin', () => {
  const provider = createLocalFileSourceProvider();
  assert.equal(provider.canResolve({ pluginId: 'local-fs', sourceId: '/x', kind: 'local' }), true);
  assert.equal(provider.canResolve({ pluginId: 'spotify', sourceId: '/x', kind: 'streaming' }), false);
});

test('resolve returns a file:// URL and the format from the extension for an existing file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'unitrack-source-local-fs-'));
  const filePath = join(dir, 'song.flac');
  await writeFile(filePath, 'not real audio, just bytes');
  try {
    const provider = createLocalFileSourceProvider();
    const resolved = await provider.resolve({ pluginId: 'local-fs', sourceId: filePath, kind: 'local' });
    assert.deepEqual(resolved, { url: pathToFileURL(filePath).href, format: 'flac' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolve omits format for a file with no extension', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'unitrack-source-local-fs-'));
  const filePath = join(dir, 'noext');
  await writeFile(filePath, 'not real audio, just bytes');
  try {
    const provider = createLocalFileSourceProvider();
    const resolved = await provider.resolve({ pluginId: 'local-fs', sourceId: filePath, kind: 'local' });
    assert.deepEqual(resolved, { url: pathToFileURL(filePath).href });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolve rejects for a nonexistent path', async () => {
  const provider = createLocalFileSourceProvider();
  await assert.rejects(
    () => provider.resolve({ pluginId: 'local-fs', sourceId: '/definitely/does/not/exist.mp3', kind: 'local' }),
    (err) => {
      assert.ok(err instanceof Error);
      return true;
    }
  );
});
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `npm test -w @unitrack/source-local-fs` (or `npm test` from inside `packages/source-local-fs`)
Expected: FAIL — `Cannot find module '../src/index.js'`.

- [ ] **Step 6: Implement `createLocalFileSourceProvider`**

`packages/source-local-fs/src/index.js`:

```js
import { access, constants } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { extname } from 'node:path';

/** @returns {import('@unitrack/core/types').SourceProvider} */
export function createLocalFileSourceProvider() {
  return {
    id: 'local-fs',
    kind: 'local',
    /**
     * @param {import('@unitrack/core/types').SourceRef} ref
     * @returns {boolean}
     */
    canResolve(ref) {
      return ref.pluginId === 'local-fs';
    },
    /**
     * @param {import('@unitrack/core/types').SourceRef} ref
     * @returns {Promise<import('@unitrack/core/types').ResolvedSource>}
     */
    async resolve(ref) {
      await access(ref.sourceId, constants.R_OK);
      const url = pathToFileURL(ref.sourceId).href;
      const ext = extname(ref.sourceId).slice(1).toLowerCase();
      const resolved = /** @type {import('@unitrack/core/types').ResolvedSource} */ ({ url });
      if (ext) resolved.format = ext;
      return resolved;
    },
  };
}
```

Note the `/** @type {...} */ (...)` cast on `resolved`: without it, TypeScript infers `resolved`'s type from the initializer literal as `{ url: string }`, and the following `resolved.format = ext;` would fail `tsc --checkJs --strict` (property `format` doesn't exist on that narrower inferred type). Casting to the full `ResolvedSource` type up front (where `format` is a valid optional property) fixes this without changing behavior.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test -w @unitrack/source-local-fs`
Expected: PASS — all 5 tests pass.

- [ ] **Step 8: Run the typecheck**

Run: `npm run typecheck -w @unitrack/source-local-fs`
Expected: no errors. If `import('@unitrack/core/types').X` fails to resolve, re-run `npm install` from the repo root first (Step 3) to confirm the workspace symlink exists at `node_modules/@unitrack/core`.

- [ ] **Step 9: Verify the whole workspace still passes from the root**

Run: `npm test` and `npm run typecheck` from the repo root.
Expected: both delegate into every workspace package (`@unitrack/core` and `@unitrack/source-local-fs`) and pass — 73 prior tests plus 5 new ones, zero typecheck errors across both packages.

- [ ] **Step 10: Commit**

```bash
git add packages/source-local-fs
git commit -m "feat: add @unitrack/source-local-fs, a local filesystem Source Provider"
```
