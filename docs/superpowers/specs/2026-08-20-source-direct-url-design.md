# @unitrack/source-direct-url — Design Spec

Date: 2026-08-20

## Purpose

The fourth `SourceProvider`, and the simplest yet. `@unitrack/source-subsonic`
and `@unitrack/source-s3` both exist to turn an opaque, provider-owned
identifier (a Subsonic track id, an S3 object key) into a playable URL —
that indirection is the whole point of those two packages. Sometimes there
is no indirection to perform: the user already has a plain, public,
directly-fetchable HTTP(S) URL to an audio file (a raw link into a static
file host, a CDN, a "direct download" link some other service handed out)
and just wants Core to play it. This package is the `SourceProvider` for
that case — motivated directly by using `@unitrack/web-demo`'s Add Track
form, where "paste a URL" is the simplest possible way to add a track and
today isn't possible without going through the Subsonic- or S3-shaped
indirection those two providers require.

## Scope

**In scope:** implementing the `SourceProvider` contract for a
directly-fetchable public URL — `canResolve`, `resolve`, `revalidate`. A
reachability/permission check via `HEAD` before returning the URL,
matching `source-subsonic`/`source-s3`'s shared "`resolve` means confirm
playable right now" principle. No factory configuration beyond an
optional `id`/`timeoutMs` — unlike every other `SourceProvider` in this
repo, this one needs no base URL, credentials, or bucket, because the
`SourceRef.token.token` a caller supplies already **is** the complete,
directly-usable URL.

**Explicitly out of scope:**
- Any authentication (headers, query tokens, signing). A URL needing auth
  to fetch belongs to `@unitrack/source-s3` (presigned) or a future
  provider built for that specific auth scheme — this package's entire
  reason to exist is the case that needs *none* of that. If the URL
  itself embeds a token/signature already (e.g. someone pastes a
  presigned S3 URL directly rather than configuring `@unitrack/source-s3`
  properly), that still works here — this provider doesn't care what's in
  the URL, only that a plain unauthenticated `HEAD` against it succeeds —
  but that isn't a scenario this package does anything special for.
- Following/pinning redirects, or validating that a redirect target is
  still audio. `fetch()`'s default redirect handling (`follow`) is used
  as-is; if a `HEAD` follows a redirect and the final response is a
  healthy 2xx, that's good enough — matching the same "trust the HTTP
  layer" posture `source-subsonic`/`source-s3` already take toward their
  own network calls.
- Validating the URL's scheme beyond what the global `URL` constructor
  itself rejects (a `javascript:`/`data:`/`file:` URL passed here is the
  caller's own error, surfaced as a fetch failure, not specially detected
  and rejected up front — this is user-supplied-URL handling no different
  in kind from `@unitrack/source-local-fs` trusting an already-known
  path).
- Persisting/bookmarking a URL beyond the lifetime of one `SourceRef` — no
  history, no favorites list. That's host/UI territory.

## Why `resolve()` still performs a `HEAD`

It would be tempting to make this the *one* provider that does zero
network work in `resolve()` — the URL is already complete, so what is
there to check? But a broken/expired/typo'd direct link is exactly the
kind of failure `Resolver.js`'s policy fallback exists to route around
(see `source-subsonic`'s and `source-s3`'s own specs for the identical
argument), and this provider is frequently the *fallback* itself in a
web-demo Add Track pairing, not just the primary — a fallback whose own
brokenness is only discovered by the engine trying and failing to play it
defeats the purpose. So `resolve()`/`revalidate()` `HEAD` the URL exactly
the way `@unitrack/source-s3`'s `headObject()` does (same status-code-only
error mapping — `403`/`404` specifically, anything else generic — and the
same bonus: a real `Content-Type` for `ResolvedSource.mime` instead of a
placeholder, sidestepping the exact bug `@unitrack/source-subsonic` had
until the preceding fix). This package's `resolve()` is, in effect,
`source-s3`'s `headObject()` helper with the presigning step removed
entirely — the URL is used as-is, not derived from a key.

## Interface

```js
/**
 * @param {{ id?: string, timeoutMs?: number }} [config]
 * @returns {import('@unitrack/core/types').SourceProvider}
 */
export function createDirectUrlSourceProvider({ id = 'direct-url', timeoutMs = 5000 } = {}) {
  return {
    id,
    kind: 'direct-url',
    canResolve(ref) {
      return ref.pluginId === id;
    },
    async resolve(ref) {
      // HEAD ref.token.token (the URL itself) — throws on network
      // failure/timeout/403/404/other non-2xx; on success reads
      // Content-Type for ResolvedSource.mime, same mapping as
      // @unitrack/source-s3's headObject().
    },
    async revalidate(token) {
      // Same HEAD, wrapped to return { valid, token, reason? }.
    },
  };
}
```

`SourceRef.token.token` is the full URL string (e.g.
`https://cdn.example.com/tracks/track-1.flac`) — opaque to `Resolver.js`,
but this is the one provider where the token is directly human-meaningful
rather than an internal identifier, which is exactly what makes it usable
straight from a UI text field with no separate "which server" connection
step (unlike Subsonic/S3, which both need a connection form first).

**Capabilities:** `{ offline: false, requiresRevalidation: true }` —
identical reasoning to `source-s3`: a direct link can go stale (the file
moved, access was revoked) between one `resolve()` and the next, so
`Resolver.js`'s one-retry-via-`revalidate()` path applies here too, even
though there's no signature to actually refresh — `revalidate()` re-`HEAD`s
the same unchanged URL, which is a legitimate, useful retry (a
transient failure or the file having come back) even without anything to
regenerate.

## Error Handling

Identical mapping to `@unitrack/source-s3`'s `headObject()` — network/
timeout surfaced as-is, `403` → `'direct url access denied'`, `404` →
`'direct url not found'`, any other non-2xx → `` `direct url head failed:
HTTP ${status}` ``. No redaction concerns beyond what already applies
everywhere: the URL itself is never a `SourceToken.token`-style secret (it
is, by this provider's whole premise, already a plain fetchable link a
user typed in) so nothing here needs special log-scrubbing beyond the
repo's existing baseline (`SourceToken.token` is still excluded from
default logging per `types.js`'s doc comment, uniformly, whether or not
its value happens to look like a URL).

## Package

```
packages/plugins/any/source-direct-url/
├── package.json      — devDependencies only: @unitrack/core, @unitrack/conformance-kit,
│                         @types/node, typescript. Zero runtime dependencies.
├── tsconfig.json
├── tsconfig.build.json
├── src/
│   └── index.js        — createDirectUrlSourceProvider({ id, timeoutMs })
└── test/
    ├── helpers/
    │   └── testServer.js  — startTestServer/headHandler, duplicated from
    │                         @unitrack/source-s3's own test helper (small,
    │                         per-package duplication — established precedent)
    └── index.test.js
```

## Testing

Against a real local `node:http` server (no mocking library):

1. **`canResolve`** returns `true` only for a ref targeting this
   provider's configured `id`.
2. **`resolve()` against a healthy `HEAD`** returns `{ kind: 'url', url:
   <the same URL from the ref>, mime: <the HEAD response's Content-Type> }`.
3. **Falls back to `application/octet-stream`** when the server sends no
   `Content-Type` (this is the one placeholder-mime case that's actually
   safe: `resolve()` always attempts a real `HEAD` first, so a caller only
   ever sees this placeholder when a real server genuinely didn't say —
   unlike `source-subsonic`'s old bug, this isn't every call).
4. **`resolve()` rejects with an access-denied message on `403`.**
5. **`resolve()` rejects with a not-found message on `404`.**
6. **`resolve()` rejects on another non-2xx status.**
7. **`resolve()` rejects when the server never responds**, within a small
   configured `timeoutMs`.
8. **`revalidate()` mirrors `resolve()`'s success/failure mapping.**
9. **Exposes `{ offline: false, requiresRevalidation: true }` capabilities.**
10. **Runs cleanly through `@unitrack/conformance-kit`'s
    `assertSourceProviderConformance()`.**

## Non-goals

Restated from Scope: authentication of any kind, redirect
following/pinning beyond `fetch()`'s own default behavior, URL-scheme
validation beyond what `URL` itself rejects, and any persistence of URLs
across `SourceRef`s are all out of scope for this package.
