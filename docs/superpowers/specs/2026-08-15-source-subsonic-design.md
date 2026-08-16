# @unitrack/source-subsonic — Design Spec

Date: 2026-08-15

## Purpose

The second `SourceProvider` plugin for `@unitrack/core`, and the first
networked one. Every package built so far — `@unitrack/source-local-fs`,
`@unitrack/engine-web-audio` — has been verified against mocks/stubs, and
`@unitrack/core`'s policy/fallback machinery (`Resolver.js`'s ordered rule
iteration, `failedSources` collection) has only ever run with a single
registered `SourceProvider`. That machinery has never actually been
exercised: with one provider, there is nothing to fall back *from*. This
package resolves a `SourceRef` pointing at a track on a self-hosted
[Subsonic API](https://opensubsonic.netlify.app/)-compatible media server
(Navidrome, Airsonic, Gonic, Ampache's Subsonic-compatible endpoint, ...)
into a playable `ResolvedSource`, giving `CorePlayer` a second, genuinely
failable source kind (`'self-hosted'`) to resolve through — a real network
call, real auth, real timeouts, real unreachable-server failures — for the
first time.

## Scope

**In scope:** implementing the `SourceProvider` contract
(`packages/core/src/types.js`) for a Subsonic-API server —
`canResolve`/`resolve` only. Token-based authentication. A reachability/auth
check before returning a stream URL.

**Explicitly out of scope:**
- Search, browsing, or listing tracks (`search3`, `getMusicDirectory`,
  ...) — that's `PlaylistProvider`/`MetadataProvider` territory, a separate
  future package, exactly as directory scanning was excluded from
  `@unitrack/source-local-fs`.
- Transcoding or bitrate selection — every stream request asks for
  `format=raw` (server-side transcoding disabled), matching
  `@unitrack/source-local-fs`'s own "bitrate is never populated" scope
  boundary.
- Fetching track metadata (`getSong.view`'s `suffix`/duration/tags) to
  populate `ResolvedSource.format` — see "Why `format` is left unset" below.
- Wiring this into `apps/electron-demo` or any real-server integration
  test. There is no Subsonic-API server available to verify against right
  now (unlike `@unitrack/engine-web-audio`, which had a real browser to
  manually check). This package ships with contract tests only; real-server
  verification and demo wiring are future work, once a server exists to
  test against.
- Retry/backoff on transient network failures. `resolve()` either succeeds
  or rejects once per call. A host wanting retry can already call
  `core.play()` again — consistent with Core's own "no auto-skip, host owns
  retry/UX policy" stance from the original design spec.
- Connectivity caching across calls. See "Why ping on every resolve()"
  below.

## Protocol

Targets the [OpenSubsonic API](https://opensubsonic.netlify.app/), the
actively-maintained, backward-compatible superset of the original
subsonic.org spec that Navidrome, Airsonic, Gonic, and others implement —
not a Navidrome-specific integration (hence `source-subsonic`, not
`source-navidrome`; package naming mirrors `source-local-fs`'s
mechanism-not-vendor convention).

**Authentication: token, not plaintext password.** Every request carries
`u` (username), `t` (token), `s` (salt), `v` (protocol version, `1.16.1`),
`c` (client name). `salt` is a fresh random hex string generated per
request (via `node:crypto.randomBytes`); `token = md5(password + salt)`,
computed via `node:crypto.createHash('md5')` — Node's own built-in, so this
adds no runtime dependency. MD5 here isn't a security design choice made by
this package; it's what the wire protocol mandates, the same way
`@unitrack/source-local-fs` didn't get to choose its own file-existence
check semantics. Verified against the OpenSubsonic docs' own worked example
(`password="sesame"`, `salt="c19b2d"` → `token="26719a1196d2a940705a59634eb18eab"`)
by running it through `node:crypto` directly — matches exactly.

**Endpoints used:**
- `GET {baseUrl}/rest/ping.view` — connectivity/credential check (see
  below). Requested with `f=json`; a healthy response is
  `{ "subsonic-response": { "status": "ok", ... } }`.
- `GET {baseUrl}/rest/stream.view` — the actual stream URL returned as
  `ResolvedSource.url`, with `id={sourceId}&format=raw` appended. This URL
  is never fetched by this package itself — it's handed to
  `@unitrack/engine-web-audio`'s `<audio>` element, which performs the
  actual (range-request-capable, progressively-loaded) GET.

## Why ping on every `resolve()`

`@unitrack/source-local-fs`'s own design spec states its principle
directly: "`resolve` means 'confirm the source is playable right now,' not
just string construction." A Subsonic stream URL can be syntactically
constructed with zero network calls — but an unreachable server, wrong
credentials, or an expired session would only surface once
`@unitrack/engine-web-audio` tries to actually load it, by which point
`CorePlayer` has already committed to this source and bound this engine
(`Resolver.js`'s "first successful `resolve()` wins" has already run its
course). For **policy fallback to mean anything** — the actual point of
this package's existence, per Purpose above — a Subsonic source failing
must be visible to `Resolver.js` *during resolution*, so it can move on to
the next `SourceProvider` in the policy. `ping.view` is the correct,
lightweight tool for this: a small JSON round-trip instead of opening a
media stream. This costs one extra network round-trip per track load (no
caching across calls — see Scope) — a deliberate, documented trade-off:
staleness from a cached "server is reachable" check would violate the same
"right now" principle it exists to serve, and this package explicitly
excludes retry/caching logic per Scope. If this round-trip's latency proves
to matter in practice, revisit with a short-lived cache as its own
follow-up, backed by real numbers rather than speculation.

## Interface

```js
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
    canResolve(ref) {
      return ref.pluginId === id;
    },
    async resolve(ref) {
      // 1. ping.view with a fresh salt/token — throws on network failure,
      //    timeout, non-2xx, or a non-"ok" subsonic-response status.
      // 2. build and return the stream.view URL with its own fresh
      //    salt/token (a ping's token must not be reused for the actual
      //    stream request — each request is independently salted, per
      //    protocol).
    },
  };
}
```

`id` is configurable (default `'subsonic'`) specifically so a host running
two different self-hosted servers (e.g. a home server and a backup) can
register both — `PluginRegistry.registerSourceProvider` throws on a
duplicate `id`, so two same-`id` instances could never coexist otherwise.

**`SourceRef.sourceId`** is the Subsonic track id (an opaque string per the
protocol — Navidrome's are MD5 hashes or UUIDs, not necessarily integers).
Obtaining that id (via search, a playlist, or manual configuration) is
entirely out of this package's scope, the same way `@unitrack/source-local-fs`
takes an already-known absolute path and never discovers one itself.

**No dependency injection for `fetch`.** `@unitrack/engine-web-audio`
needed constructor-injected `AudioConstructor`/`AudioContextConstructor`
specifically because `Audio`/`AudioContext` don't exist in Node at all.
`fetch` and `AbortController` are both real, stable Node globals (verified
directly: `typeof fetch === 'function'` on this repo's Node 22, and
available since Node 18, this package's own floor per its `engines` field)
— so, like `@unitrack/source-local-fs`'s zero-DI use of `node:fs`, tests run
against a real local `node:http` server rather than injecting or mocking
the transport. Consistent with the "write a real dependency-free stand-in,
not a mock" approach already used for `EventEmitter` and the DOM stub in
`@unitrack/engine-web-audio`'s own tests — here, the "stand-in" is simply a
real, tiny local server.

**`timeoutMs`** (default 5000) exists so an unreachable/hanging server
produces a bounded rejection rather than hanging `resolve()` (and therefore
`CorePlayer`'s `'loading'` status) indefinitely. Implemented via
`AbortController` + `setTimeout(() => controller.abort(), timeoutMs)`, and
also gives the test suite a way to exercise the timeout path quickly
(configuring a very small `timeoutMs` against a deliberately slow local
test server, rather than waiting out a real multi-second timeout).

### Why `format` is left unset

`ResolvedSource.format` is optional, and this package never sets it —
determining a track's actual format (`suffix` from Subsonic's per-track
metadata) requires a `getSong.view` call this package doesn't make (that's
metadata-fetching, explicitly out of scope above). This is safe by
construction, not a gap silently papered over:
`@unitrack/engine-web-audio`'s own `canPlay()` already treats a missing
`format` as permissive ("returns `true` — the table is a convenience, not
authoritative"), specifically anticipating a `SourceProvider` that can't
supply one.

## Error Handling

`ping.view` failures reject with a plain `Error` and a message drawn from
whichever of these actually happened (checked in order):
1. **Network/timeout** — `Error` from `fetch`'s own rejection or the abort,
   surfaced as-is (`fetch`'s own messages are already informative, same
   reasoning `@unitrack/source-local-fs` applied to `fs.access`'s
   rejection).
2. **Non-2xx HTTP status** — `` `subsonic ping failed: HTTP ${status}` ``.
3. **`subsonic-response.status !== 'ok'`** — Subsonic error responses
   include a numbered `error.code` and human-readable `error.message`;
   surfaced as `` `subsonic ping failed: ${error.message} (code ${error.code})` ``.

No wrapping beyond that — `packages/core/src/Resolver.js` already catches
`resolve()` rejections and records `err.message` into `failedSources`,
exactly as it does for `@unitrack/source-local-fs` today.

## Package

```
packages/source-subsonic/
├── package.json      — devDependencies: @unitrack/core, typescript, @types/node
├── tsconfig.json      — "lib": ["ES2022"], @types/node (no "DOM" — fetch/AbortController
│                         come from @types/node's ambient Node globals, not the DOM lib,
│                         same reasoning as @unitrack/source-local-fs's tsconfig)
├── src/
│   └── index.js        — createSubsonicSourceProvider({ baseUrl, username, password, ... })
└── test/
    ├── helpers/
    │   └── testServer.js  — starts/stops a real node:http server on an ephemeral port,
    │                         with test-controlled ping.view/stream.view responses
    └── index.test.js
```

Zero runtime dependencies — same posture as `@unitrack/source-local-fs`.
`@unitrack/core` stays a devDependency only, for JSDoc types against
`@unitrack/core/types`; nothing at runtime imports code from it.

## Testing

A real `node:http` server, started on an ephemeral port per test (no
mocking library — matching this project's established practice of writing
small, real, dependency-free stand-ins), with handlers the test controls:

1. **`canResolve`** returns `true` only for a ref whose `pluginId` matches
   the configured `id` (default `'subsonic'` and a custom one).
2. **A healthy ping + successful resolve** produces a `stream.view` URL
   containing the expected `id`, `format=raw`, `u`, `v`, `c`, and a
   `t`/`s` pair where `t` independently recomputes to
   `md5(password + s)` — proving the token/salt relationship is correct
   without needing to control salt generation.
3. **Two consecutive `resolve()` calls use different salts** (and
   therefore different tokens) — no salt reuse across requests.
4. **`resolve()` rejects when `ping.view` returns `status: "failed"`**
   (simulated wrong-credentials response), with the Subsonic error
   message and code in the rejection.
5. **`resolve()` rejects on a non-2xx HTTP status** from `ping.view`.
6. **`resolve()` rejects when the server never responds**, using a small
   configured `timeoutMs` against a handler that deliberately never sends
   a response — proves the `AbortController` timeout path without
   slowing down the test suite with a real multi-second wait.
7. **Two providers with different configured `id`s can both be registered**
   on the same `PluginRegistry` without the duplicate-id throw — a
   `CorePlayer`-level test (in `test/CorePlayer.test.js` or this package's
   own suite; final placement decided in the implementation plan) using two
   `createSubsonicSourceProvider` instances pointed at two different test
   servers.

## Non-goals

Restated from Scope: search/browse, transcoding/bitrate selection, format
detection via metadata, demo/real-server integration, and retry/caching
logic are all out of scope for this package.
