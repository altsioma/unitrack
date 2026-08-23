# @unitrack/source-direct-url Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `@unitrack/source-direct-url` — a `SourceProvider` that treats `SourceRef.token.token` as a complete, directly-fetchable URL, `HEAD`-checking it in `resolve()`/`revalidate()` for a real `Content-Type` and a live reachability check — as specified in `docs/superpowers/specs/2026-08-20-source-direct-url-design.md`. Then wire it into `@unitrack/web-demo` as a third Add Track provider option.

**Architecture:** A single new npm workspace package, `packages/plugins/any/source-direct-url/`, exporting `createDirectUrlSourceProvider({ id, timeoutMs })`. No signing, no factory config beyond `id`/`timeoutMs` — this is `@unitrack/source-s3`'s `headObject()` helper with the presigning step removed; the URL is used as-is. Zero runtime dependencies.

## Global Constraints

- No authentication of any kind — see spec Non-goals.
- `resolve()`/`revalidate()` always perform a live `HEAD` — no connectivity caching, matching every other networked provider in this repo.
- `npm run typecheck` and `npm test`, from the repo root, must both pass cleanly at the end of the task, including `@unitrack/web-demo`'s typecheck after Task 2's wiring.

---

## Task 1: Implement and test `createDirectUrlSourceProvider`

**Files:**
- Create: `packages/plugins/any/source-direct-url/package.json`, `tsconfig.json`, `tsconfig.build.json` — identical shape to `@unitrack/source-s3`'s own (see that package), `name: "@unitrack/source-direct-url"`.
- Create: `packages/plugins/any/source-direct-url/src/index.js`
- Create: `packages/plugins/any/source-direct-url/test/helpers/testServer.js` — duplicate of `@unitrack/source-s3`'s `startTestServer`/`headHandler`.
- Create: `packages/plugins/any/source-direct-url/test/index.test.js` — the 10 tests from the spec's Testing section, same shape as `@unitrack/source-s3`'s `test/index.test.js` (a `refFor(pluginId, url)` helper where the token is the URL itself, a `providerFor(overrides)` helper).

- [ ] **Step 1: Scaffold `package.json`/`tsconfig.json`/`tsconfig.build.json`** — copy `@unitrack/source-s3`'s, rename, drop the SigV4-specific description text.

- [ ] **Step 2: Write `src/index.js`**

```js
import { CONTRACT_VERSION } from '@unitrack/core/types';

/**
 * HEAD-checks `url` directly — no presigning step (unlike
 * @unitrack/source-s3's headObject(), the URL passed in is already
 * complete and final). Same status-code-only error mapping.
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<{ contentType: string }>}
 */
async function headUrl(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  /** @type {Response} */
  let response;
  try {
    response = await fetch(url, { method: 'HEAD', signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
  if (response.status === 403) throw new Error('direct url access denied');
  if (response.status === 404) throw new Error('direct url not found');
  if (!response.ok) throw new Error(`direct url head failed: HTTP ${response.status}`);
  return { contentType: response.headers.get('content-type') ?? 'application/octet-stream' };
}

/**
 * @param {{ id?: string, timeoutMs?: number }} [config]
 * @returns {import('@unitrack/core/types').SourceProvider}
 */
export function createDirectUrlSourceProvider({ id = 'direct-url', timeoutMs = 5000 } = {}) {
  return {
    id,
    kind: 'direct-url',
    contractVersion: CONTRACT_VERSION,
    capabilities: { offline: false, requiresRevalidation: true },
    async initialize(ctx) {},
    async dispose() {},
    async canResolve(ref) {
      return ref.pluginId === id;
    },
    async resolve(ref) {
      const url = ref.token.token;
      const { contentType } = await headUrl(url, timeoutMs);
      return { kind: 'url', url, mime: contentType };
    },
    async revalidate(token) {
      try {
        await headUrl(token.token, timeoutMs);
        return { valid: true, token };
      } catch (err) {
        return { valid: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
```

- [ ] **Step 3: Write the test suite, run, fix until green**

Run: `npm install` (links the new workspace package) then `npm test -w @unitrack/source-direct-url`. Expected: 10/10 passing after implementation (mirrors `@unitrack/source-s3`'s own 13 provider-level tests minus the two `id`-override/capabilities ones this spec doesn't call out separately — include them anyway if convenient, matching that package's thoroughness).

- [ ] **Step 4: Typecheck + `build:types` for this package alone**

Run: `npm run typecheck -w @unitrack/source-direct-url`, `npm run build:types -w @unitrack/source-direct-url`. Expected: clean.

---

## Task 2: Wire into `@unitrack/web-demo`

**Files:**
- Modify: `apps/web-demo/package.json` (new dependency)
- Modify: `apps/web-demo/plugins.js` (manifest entry + re-export)
- Modify: `apps/web-demo/main.js` (register immediately — no connect form needed, since this provider takes no config; add `'direct-url'` as a third `<option>` in both the primary/fallback provider selects)
- Modify: `apps/web-demo/index.template.html` (third `<option value="direct-url">Direct URL</option>` in both selects; primary/fallback key inputs' placeholder text can stay generic — "track id / object key / URL" — rather than growing a third input pair, since this provider's "key" is simply pasted straight into the same key field the other two already use)

- [ ] **Step 5: `plugins.js`** — add `{ category: 'source', packageName: '@unitrack/source-direct-url' }` to `PLUGIN_MANIFEST`, import and re-export `createDirectUrlSourceProvider`.

- [ ] **Step 6: `main.js`** — register `createDirectUrlSourceProvider()` unconditionally alongside the playback engine at startup (no connect form, no credentials — the whole point per spec). Update `kindFor()` in the Add Track handler: `pluginId === 'subsonic' ? 'self-hosted' : pluginId === 's3' ? 'object-storage' : 'direct-url'`.

- [ ] **Step 7: `index.template.html`** — add the third `<option>` to `#primary-provider` and `#fallback-provider`.

- [ ] **Step 8: Manual/headless re-verification**

Re-run the Playwright smoke check (page loads cleanly, zero console errors, `direct-url` option present) and, if practical, a live check pointing "primary" at a real reachable static file URL (or a local fake server) proving `resolve()` succeeds without any connect step — no server credentials needed for this one, unlike the Subsonic/S3 checks.

- [ ] **Step 9: README + full workspace verification**

Add a `@unitrack/source-direct-url` row to the Packages table. Run `npm install`, `npm test`, `npm run build:types`, `npm run typecheck` from the repo root — all clean, all prior tests still passing, `@unitrack/web-demo` typechecks with the new import.

- [ ] **Step 10: Commit**

```bash
git add packages/plugins/any/source-direct-url apps/web-demo README.md docs/superpowers/specs/2026-08-20-source-direct-url-design.md docs/superpowers/plans/2026-08-20-source-direct-url.md
git commit -m "feat: add @unitrack/source-direct-url, a plain-URL Source Provider, wired into web-demo"
```
