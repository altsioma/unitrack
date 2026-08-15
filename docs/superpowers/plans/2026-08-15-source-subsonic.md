# @unitrack/source-subsonic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@unitrack/source-subsonic` — a `SourceProvider` plugin for `@unitrack/core` that resolves a `SourceRef` pointing at a track on a Subsonic-API-compatible self-hosted server into a signed `stream.view` `ResolvedSource`, pinging the server first so an unreachable/misauthenticated source fails visibly during resolution — as specified in `docs/superpowers/specs/2026-08-15-source-subsonic-design.md`.

**Architecture:** A single new npm workspace package, `packages/source-subsonic/`, exporting one factory function, `createSubsonicSourceProvider(config)`, returning a plain object satisfying `@unitrack/core`'s `SourceProvider` contract. No runtime dependency on `@unitrack/core` (devDependency only, for JSDoc types). Auth token generation uses `node:crypto` (`randomBytes` for the salt, `createHash('md5')` for the token) — both Node built-ins, no new runtime dependency. `fetch`/`AbortController` are real Node globals, not injected.

**Tech Stack:** Plain JavaScript (ESM) with JSDoc types checked via `tsc --checkJs --strict`. Tests via Node's built-in `node:test` + `node:assert/strict`, against a real `node:http` server on an ephemeral localhost port (no mocking library). Zero runtime dependencies.

## Global Constraints

- Zero runtime dependencies. `@unitrack/core`, `@types/node`, and `typescript` are devDependencies only.
- Auth: token-based only (`u`/`t`/`s`/`v`/`c` query params). No plaintext-password (`p`) code path — token auth is universally supported by modern Subsonic-API servers (API >= 1.13.0) and is the only scheme this package implements.
- Every `resolve()` call pings the server (`GET /rest/ping.view`) before returning a `stream.view` URL, and generates a fresh salt/token for each of the two requests independently (a ping's token is never reused for the stream URL). No connectivity caching across calls.
- `stream.view` URLs always include `format=raw` (no transcoding) and never set `ResolvedSource.format` (no metadata fetch to determine it — see spec, "Why `format` is left unset").
- Out of scope for this plan (per spec Non-goals): search/browse/playlist fetching, transcoding/bitrate selection, metadata fetching, `apps/electron-demo` wiring, any real-server integration test, retry/backoff logic.
- `npm run typecheck` and `npm test`, run from the repo root, must both pass cleanly (delegating into every workspace package, including this new one) at the end of the task.

---

## Task 1: Scaffold and implement @unitrack/source-subsonic

**Files:**
- Create: `packages/source-subsonic/package.json`
- Create: `packages/source-subsonic/tsconfig.json`
- Create: `packages/source-subsonic/src/index.js`
- Create: `packages/source-subsonic/test/helpers/testServer.js`
- Create: `packages/source-subsonic/test/index.test.js`

**Interfaces:**
- Consumes: `@unitrack/core`'s JSDoc types (`SourceRef`, `ResolvedSource`, `SourceProvider`) from `packages/core/src/types.js`, referenced via `import('@unitrack/core/types').X`, resolvable once `npm install` links the workspace. No runtime import from `@unitrack/core`. Consumes Node built-ins `node:crypto` (`randomBytes`, `createHash`), `node:http` (`createServer`, test helper only), and the global `fetch`/`AbortController`/`URL`.
- Produces: `export function createSubsonicSourceProvider(config): SourceProvider` from `packages/source-subsonic/src/index.js` — this package's entire public surface. Test-only: `startTestServer(handler)` and `pingHandler(config)` from `test/helpers/testServer.js`.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "@unitrack/source-subsonic",
  "version": "0.1.0",
  "description": "Subsonic API Source Provider plugin for @unitrack/core",
  "type": "module",
  "engines": {
    "node": ">=18"
  },
  "main": "src/index.js",
  "exports": "./src/index.js",
  "scripts": {
    "test": "node --test test/*.test.js",
    "typecheck": "tsc -p tsconfig.json"
  },
  "devDependencies": {
    "@types/node": "^18",
    "@unitrack/core": "^0.1.0",
    "typescript": "^5.5.4"
  }
}
```

`"test": "node --test test/*.test.js"` — unquoted single-star glob, matching the shell-expanded pattern every other package in this repo now uses (`docs/superpowers/specs/...` isn't relevant here — see commit `0a70d4e`, "fix: use a shell-expanded glob for node --test in every package"). Do not reintroduce the quoted `**` form.

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

Same as `@unitrack/source-local-fs`'s `tsconfig.json` — no `"DOM"` in `lib`. `@types/node` is expected to provide ambient types for `fetch`/`AbortController`/`Response`/`URL` (these are real Node 18+ globals). If Step 8's typecheck reports `Cannot find name 'fetch'` (or similar) despite `@types/node` being installed, that means this floor version of `@types/node` predates fetch's ambient typings — bump the `@types/node` version pinned in Step 1 (do not add `"DOM"` to `lib`, which would pull in unrelated browser globals for a Node-only package) and re-run. Record whatever the actual fix was in the commit message, the same way `fe72f12` ("fix(plan): add @types/node devDependency and a type-cast the plan missed") documented the equivalent gap in the original `@unitrack/source-local-fs` plan.

- [ ] **Step 3: Install from the repo root**

Run (from the repo root, not from inside `packages/source-subsonic`): `npm install`
Expected: npm recognizes the new workspace package, links `node_modules/@unitrack/core` and `node_modules/@unitrack/source-subsonic` as workspace symlinks, installs `typescript`/`@types/node` for the new package.

- [ ] **Step 4: Write the test server helper**

`packages/source-subsonic/test/helpers/testServer.js`:

```js
import { createServer } from 'node:http';

/**
 * Starts a real HTTP server on an ephemeral localhost port for a single
 * test. No mocking library — a real server, matching this project's
 * established practice of writing small, real stand-ins (the DOM stub in
 * @unitrack/engine-web-audio, real temp files in @unitrack/source-local-fs)
 * instead of mocking libraries.
 *
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void} handler
 * @returns {Promise<{ baseUrl: string, close: () => Promise<void> }>}
 */
export function startTestServer(handler) {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (address).port}`,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

/**
 * @param {{ status: 'ok' | 'failed', errorCode?: number, errorMessage?: string }} config
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function pingHandler({ status, errorCode = 40, errorMessage = 'Wrong username or password.' }) {
  return (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const body = status === 'ok'
      ? { 'subsonic-response': { status: 'ok', version: '1.16.1' } }
      : { 'subsonic-response': { status: 'failed', version: '1.16.1', error: { code: errorCode, message: errorMessage } } };
    res.end(JSON.stringify(body));
  };
}
```

The `/** @type {...} */` cast on `address` mirrors the same pattern `@unitrack/source-local-fs`'s plan used for `resolved` in its `resolve()` — `server.address()`'s return type is `string | AddressInfo | null`, and only `AddressInfo` has `.port`; the cast is safe here because `server.listen(0, ...)` (a numeric port) always yields an `AddressInfo`, never a string (that variant is only for Unix sockets) or `null` (only before `listen()`/after `close()`).

- [ ] **Step 5: Write the failing tests**

`packages/source-subsonic/test/index.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createSubsonicSourceProvider } from '../src/index.js';
import { startTestServer, pingHandler } from './helpers/testServer.js';

test("canResolve returns true only for a ref targeting this provider's id", () => {
  const provider = createSubsonicSourceProvider({ baseUrl: 'http://example.invalid', username: 'u', password: 'p' });
  assert.equal(provider.canResolve({ pluginId: 'subsonic', sourceId: 'x', kind: 'self-hosted' }), true);
  assert.equal(provider.canResolve({ pluginId: 'local-fs', sourceId: 'x', kind: 'local' }), false);
});

test('id defaults to "subsonic" and can be overridden, so two servers can be registered side by side', () => {
  const a = createSubsonicSourceProvider({ baseUrl: 'http://a.invalid', username: 'u', password: 'p' });
  const b = createSubsonicSourceProvider({ baseUrl: 'http://b.invalid', username: 'u', password: 'p', id: 'subsonic-backup' });
  assert.equal(a.id, 'subsonic');
  assert.equal(b.id, 'subsonic-backup');
  assert.equal(a.canResolve({ pluginId: 'subsonic-backup', sourceId: 'x', kind: 'self-hosted' }), false);
  assert.equal(b.canResolve({ pluginId: 'subsonic-backup', sourceId: 'x', kind: 'self-hosted' }), true);
});

test('resolve() against a healthy server returns a correctly-signed stream.view URL', async () => {
  const { baseUrl, close } = await startTestServer(pingHandler({ status: 'ok' }));
  try {
    const provider = createSubsonicSourceProvider({ baseUrl, username: 'alice', password: 'sesame', clientName: 'unitrack-test' });
    const resolved = await provider.resolve({ pluginId: 'subsonic', sourceId: 'track-42', kind: 'self-hosted' });
    const url = new URL(resolved.url);
    assert.equal(url.pathname, '/rest/stream.view');
    assert.equal(url.searchParams.get('u'), 'alice');
    assert.equal(url.searchParams.get('v'), '1.16.1');
    assert.equal(url.searchParams.get('c'), 'unitrack-test');
    assert.equal(url.searchParams.get('id'), 'track-42');
    assert.equal(url.searchParams.get('format'), 'raw');
    assert.equal(resolved.format, undefined);
    const salt = url.searchParams.get('s');
    const token = url.searchParams.get('t');
    assert.equal(token, createHash('md5').update('sesame' + salt, 'utf8').digest('hex'));
  } finally {
    await close();
  }
});

test('two consecutive resolve() calls use different salts', async () => {
  const { baseUrl, close } = await startTestServer(pingHandler({ status: 'ok' }));
  try {
    const provider = createSubsonicSourceProvider({ baseUrl, username: 'alice', password: 'sesame' });
    const first = await provider.resolve({ pluginId: 'subsonic', sourceId: 't1', kind: 'self-hosted' });
    const second = await provider.resolve({ pluginId: 'subsonic', sourceId: 't1', kind: 'self-hosted' });
    const saltA = new URL(first.url).searchParams.get('s');
    const saltB = new URL(second.url).searchParams.get('s');
    assert.notEqual(saltA, saltB);
  } finally {
    await close();
  }
});

test('resolve() rejects when the server reports wrong credentials', async () => {
  const { baseUrl, close } = await startTestServer(
    pingHandler({ status: 'failed', errorCode: 40, errorMessage: 'Wrong username or password.' })
  );
  try {
    const provider = createSubsonicSourceProvider({ baseUrl, username: 'alice', password: 'wrong' });
    await assert.rejects(
      () => provider.resolve({ pluginId: 'subsonic', sourceId: 't1', kind: 'self-hosted' }),
      /Wrong username or password\..*code 40/
    );
  } finally {
    await close();
  }
});

test('resolve() rejects on a non-2xx HTTP status from ping.view', async () => {
  const { baseUrl, close } = await startTestServer((req, res) => {
    res.writeHead(503, { 'Content-Type': 'text/plain' });
    res.end('service unavailable');
  });
  try {
    const provider = createSubsonicSourceProvider({ baseUrl, username: 'alice', password: 'sesame' });
    await assert.rejects(
      () => provider.resolve({ pluginId: 'subsonic', sourceId: 't1', kind: 'self-hosted' }),
      /HTTP 503/
    );
  } finally {
    await close();
  }
});

test('resolve() rejects when the server never responds, within the configured timeout', async () => {
  const { baseUrl, close } = await startTestServer(() => {
    // Deliberately never call res.end() — simulates an unreachable/hanging server.
  });
  try {
    const provider = createSubsonicSourceProvider({ baseUrl, username: 'alice', password: 'sesame', timeoutMs: 50 });
    const start = Date.now();
    await assert.rejects(() => provider.resolve({ pluginId: 'subsonic', sourceId: 't1', kind: 'self-hosted' }));
    assert.ok(Date.now() - start < 2000, 'rejected promptly via the configured timeout, not a default/hung wait');
  } finally {
    await close();
  }
});
```

Test count note: this is 7 tests, one fewer than the spec's Testing section lists — the spec's item 7 ("two providers ... can both be registered on the same `PluginRegistry`") is covered here by the simpler, self-contained "`id` defaults to..." test above instead, which checks the same thing (distinct `id`s, correct `canResolve` isolation) without importing `@unitrack/core`'s `PluginRegistry` into this package's own test suite — `PluginRegistry`'s own duplicate-id-throws behavior is already covered by `packages/core/test/PluginRegistry.test.js` and doesn't need re-proving here.

- [ ] **Step 6: Run the tests to verify they fail**

Run: `npm test -w @unitrack/source-subsonic` (or `npm test` from inside `packages/source-subsonic`)
Expected: FAIL — `Cannot find module '../src/index.js'`.

- [ ] **Step 7: Implement `createSubsonicSourceProvider`**

`packages/source-subsonic/src/index.js`:

```js
import { randomBytes, createHash } from 'node:crypto';

const API_VERSION = '1.16.1';

/**
 * @param {string} password
 * @returns {{ token: string, salt: string }}
 */
function computeAuth(password) {
  const salt = randomBytes(12).toString('hex');
  const token = createHash('md5').update(password + salt, 'utf8').digest('hex');
  return { token, salt };
}

/**
 * @param {string} baseUrl
 * @param {string} path
 * @param {{ username: string, password: string, clientName: string, extraParams?: Record<string, string> }} config
 * @returns {URL}
 */
function buildUrl(baseUrl, path, { username, password, clientName, extraParams = {} }) {
  const { token, salt } = computeAuth(password);
  const url = new URL(path, baseUrl);
  url.searchParams.set('u', username);
  url.searchParams.set('t', token);
  url.searchParams.set('s', salt);
  url.searchParams.set('v', API_VERSION);
  url.searchParams.set('c', clientName);
  for (const [key, value] of Object.entries(extraParams)) {
    url.searchParams.set(key, value);
  }
  return url;
}

/**
 * @param {{
 *   baseUrl: string,
 *   username: string,
 *   password: string,
 *   id?: string,
 *   clientName?: string,
 *   timeoutMs?: number,
 * }} config
 * @returns {import('@unitrack/core/types').SourceProvider}
 */
export function createSubsonicSourceProvider({
  baseUrl,
  username,
  password,
  id = 'subsonic',
  clientName = 'unitrack',
  timeoutMs = 5000,
}) {
  return {
    id,
    kind: 'self-hosted',
    /**
     * @param {import('@unitrack/core/types').SourceRef} ref
     * @returns {boolean}
     */
    canResolve(ref) {
      return ref.pluginId === id;
    },
    /**
     * @param {import('@unitrack/core/types').SourceRef} ref
     * @returns {Promise<import('@unitrack/core/types').ResolvedSource>}
     */
    async resolve(ref) {
      const pingUrl = buildUrl(baseUrl, '/rest/ping.view', {
        username, password, clientName, extraParams: { f: 'json' },
      });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      /** @type {Response} */
      let response;
      try {
        response = await fetch(pingUrl, { signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }
      if (!response.ok) {
        throw new Error(`subsonic ping failed: HTTP ${response.status}`);
      }
      const body = await response.json();
      const subsonicResponse = body['subsonic-response'];
      if (subsonicResponse?.status !== 'ok') {
        const error = subsonicResponse?.error;
        throw new Error(`subsonic ping failed: ${error?.message ?? 'unknown error'} (code ${error?.code ?? 'unknown'})`);
      }

      const streamUrl = buildUrl(baseUrl, '/rest/stream.view', {
        username, password, clientName,
        extraParams: { id: ref.sourceId, format: 'raw' },
      });
      return { url: streamUrl.href };
    },
  };
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm test -w @unitrack/source-subsonic`
Expected: PASS — all 7 tests pass. Run 2-3 times to confirm the timeout test isn't flaky (it depends on real elapsed time, same caution as `@unitrack/core`'s existing concurrency tests).

- [ ] **Step 9: Run the typecheck**

Run: `npm run typecheck -w @unitrack/source-subsonic`
Expected: no errors. If `import('@unitrack/core/types').X` fails to resolve, re-run `npm install` from the repo root first (Step 3). If `fetch`/`AbortController`/`Response` are reported as unknown names, see Step 2's note on bumping `@types/node`.

- [ ] **Step 10: Verify the whole workspace still passes from the root**

Run: `npm test` and `npm run typecheck` from the repo root.
Expected: both delegate into every workspace package and pass — 105 prior tests (80 core + 19 engine-web-audio + 6 source-local-fs, per commit `dc4494e`) plus 7 new ones in `@unitrack/source-subsonic`, zero typecheck errors across every package.

- [ ] **Step 11: Commit**

```bash
git add packages/source-subsonic
git commit -m "feat: add @unitrack/source-subsonic, a Subsonic API Source Provider"
```
