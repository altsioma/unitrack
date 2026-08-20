# @unitrack/source-s3 — Design Spec

Date: 2026-08-20

## Purpose

The third `SourceProvider` plugin for `@unitrack/core`, after
`@unitrack/source-local-fs` (a local filesystem path) and
`@unitrack/source-subsonic` (a music-domain-aware self-hosted API). This
package resolves a `SourceRef` pointing at an object key in an S3-compatible
bucket (AWS S3 itself, MinIO, Backblaze B2's S3-compatible endpoint, Ceph
RGW, ...) into a playable `ResolvedSource` — the first `SourceProvider` in
this repo targeting a backend with **no concept of a "track" at all**, only
opaque byte-addressable objects. Where `source-subsonic` proved the
`SourceProvider` contract works against a music-aware API, this package
proves it degrades cleanly to a backend that knows nothing about music,
tags, or streaming semantics — just `GET`/`HEAD` on a key. That is the real
test of whether `SourceRef`/`ResolvedSource` are actually the right
abstraction boundary, not just a convenient one for the two backends that
happened to be built first.

## Scope

**In scope:** implementing the `SourceProvider` contract
(`packages/core/src/types.js`) for an S3-compatible bucket — `canResolve`,
`resolve`, `revalidate`. Presigned-URL authentication via AWS Signature
Version 4 (query-string signing style). A reachability/permission check
before returning a stream URL (mirrors `source-subsonic`'s "resolve means
confirm playable right now" principle — see below). Both path-style and
virtual-hosted-style bucket addressing, since self-hosted S3-compatible
servers (MinIO in particular) commonly require path-style while AWS itself
defaults to virtual-hosted.

**Explicitly out of scope:**
- Bucket listing/browsing (`ListObjectsV2`) — that is `PlaylistProvider`
  territory, the same boundary `source-subsonic` drew around `search3`/
  `getMusicDirectory`. A future `@unitrack/playlist-s3` is a natural
  follow-up, not part of this package.
- Reading object tags/user metadata to populate `LogicalTrack.metadata` —
  `MetadataProvider` territory, out of scope the same way `source-subsonic`
  never calls `getSong.view`.
- Any write path (`PutObject`, multipart upload, delete). This package only
  ever presigns `GET`/`HEAD`.
- An SDK-style credential provider chain (environment variables, EC2/ECS
  instance metadata, shared credentials file, SSO). Only explicit, static
  `accessKeyId`/`secretAccessKey`(/`sessionToken`) config is accepted —
  obtaining those is the host's problem, exactly as `source-local-fs` takes
  an already-known path and `source-subsonic` takes an already-known
  username/password.
- Range-request or multipart-download optimization. A presigned `GET` URL
  is a plain HTTP(S) URL; the browser `<audio>` element (via
  `@unitrack/media-delivery-web`'s header-less passthrough — see below) and
  Electron's native engine both already issue their own range requests
  against any URL without this package doing anything special.
- Bucket/CORS/IAM policy setup guidance. Deployment concern, not code —
  same posture the original core design spec takes toward host-side
  concerns in general.

## Protocol

**Presigned URL (query-string) signing, not header signing.** AWS
Signature Version 4 supports two signing styles: putting the signature in
an `Authorization` header (requires the actual HTTP client to add that
header per-request), or embedding it as `X-Amz-*` query parameters on a
URL that is valid standalone for `X-Amz-Expires` seconds. This package
uses the query-string style exclusively, for a concrete architectural
reason: a query-string-signed URL is just `{ kind: 'url', url, mime }` with
**no `headers` field** — the exact same shape `source-local-fs` and
`source-subsonic` already produce. That means it flows through
`@unitrack/media-delivery-web`'s cheap header-less passthrough path (`{
url, release: () => {} }`, no `fetch`-and-blob detour) exactly like every
other source today, and Electron's native engine can hand the URL straight
to its media pipeline. Header-based signing would have forced every S3
playback through the fetch-and-blob lease path for no benefit — the whole
point of a presigned URL is that it is self-contained.

**Addressing style.** `forcePathStyle` (default `true`) selects between:
- path-style: `{endpoint}/{bucket}/{key}` — required by most self-hosted
  S3-compatible servers (MinIO's default configuration rejects
  virtual-hosted requests unless a wildcard DNS/TLS cert is set up for
  it), so this is the friendlier default for this package's primary
  audience (a self-hosted bucket, the same "self-hosted first" posture
  `source-subsonic` already has).
- virtual-hosted: `{scheme}://{bucket}.{endpointHost}/{key}` — real AWS
  S3's own default and what AWS's own documentation examples use.

Both styles sign identically; only the resulting `Host` header/URL differs
— see Interface below.

**Signing key derivation** (unchanged AWS SigV4, four chained
`HMAC-SHA256` calls):
```
kDate    = HMAC-SHA256("AWS4" + secretAccessKey, dateStamp)
kRegion  = HMAC-SHA256(kDate, region)
kService = HMAC-SHA256(kRegion, "s3")
kSigning = HMAC-SHA256(kService, "aws4_request")
signature = HMAC-SHA256(kSigning, stringToSign)
```

**Why `crypto.subtle`, not a hand-rolled implementation.**
`source-subsonic`'s `md5.js` hand-rolls MD5 from scratch specifically
because `SubtleCrypto` has no MD5 algorithm at all — Subsonic's legacy
auth scheme leaves no other choice. SigV4 needs only `SHA-256` and
`HMAC-SHA256`, both directly supported by the standard, portable
`SubtleCrypto` API (`globalThis.crypto.subtle`, available in Node 18+ and
every evergreen browser — the same `globalThis.crypto` global
`source-subsonic`'s `randomHex()` already relies on). No hand-rolled crypto
is needed or justified here. The one consequence: `SubtleCrypto.digest()`/
`.sign()` are `Promise`-based, so this package's signer
(`presignGetUrl()`) is `async` — unlike `md5Hex()`, which is synchronous.

**Verified against AWS's own published worked example.** AWS's
"Authenticating Requests: Using Query Parameters" documentation
(`sigv4-query-string-auth`) publishes a complete worked example (bucket
`examplebucket`, key `test.txt`, region `us-east-1`, a fixed example
access/secret key pair, timestamp `20130524T000000Z`, `X-Amz-Expires=86400`)
with every intermediate value: the exact canonical request string, its
SHA-256 hash (`3bfa2928...58ad04`), the string-to-sign, and the final
signature (`aeeed9bb...604d404`). Independently reproduced by hand (a
throwaway Python script implementing the same canonical-request-building
and HMAC chain against those exact literal inputs) before writing this
spec — both the intermediate hash and the final signature matched exactly.
This exact fixture becomes this package's primary signer test (see
Testing) — the same "cross-check against the protocol's own published
worked example" rigor `source-subsonic`'s spec used for its MD5 token.

**The `UriEncode` gotcha.** SigV4's canonical-request encoding is *not*
`encodeURIComponent` — it additionally percent-encodes `! ' ( ) *`, which
`encodeURIComponent` leaves untouched by default, and it must never encode
a canonical-URI path's `/` separators while *always* encoding `/` inside a
canonical-query value (visible in AWS's own example:
`X-Amz-Credential=...%2Fus-east-1%2Fs3%2Faws4_request`, `/` → `%2F`). This
is documented here because it is the single most common source of bugs in
from-scratch SigV4 implementations, and gets its own explicit test case
(an object key containing a space and a `+`) rather than relying on the
happy-path fixture alone to catch it.

## Why `resolve()` performs a `HEAD`, not just presigning

Presigning is pure local computation — no network call is *required* to
produce a syntactically valid URL, the same observation `source-subsonic`'s
spec makes about constructing a `stream.view` URL. But per that same
spec's own principle ("`resolve` means confirm the source is playable right
now, not just string construction"), a bad key, wrong credentials, or a
bucket that has since been deleted must surface **during resolution**, so
`Resolver.js`'s policy fallback can move on to the next `SourceProvider` —
otherwise the failure only surfaces once the engine tries to load the URL,
by which point `Resolver.js` has already committed to this source. Unlike
Subsonic (which has a dedicated `ping.view`), S3 has no separate
health-check endpoint — so `resolve()` issues a `HEAD` against the actual
presigned object URL, which doubles as both the reachability/permission
check and (bonus, unavailable to `source-subsonic`) a source of a **real**
`Content-Type` for `ResolvedSource.mime`, read from the `HEAD` response's
own `Content-Type` header instead of the `application/octet-stream`
placeholder `source-subsonic` is forced to use.

**`HEAD` responses never carry a body** (RFC 7231) — including S3's own
error responses. A `GET` request to a missing/forbidden S3 object returns
an XML `<Error><Code>...` body; a `HEAD` request to the same object returns
only the status code, no body at all. So, unlike `source-subsonic`'s
JSON-body error parsing, this package's error messages are derived from
the HTTP status code alone: `403` → access denied (bad signature/expired
credentials), `404` → object not found, anything else →
`` `s3 head failed: HTTP ${status}` ``. This is deliberate, not a missed
case — there is nothing else to parse.

## Interface

```js
/**
 * @param {{
 *   endpoint: string,
 *   region: string,
 *   bucket: string,
 *   accessKeyId: string,
 *   secretAccessKey: string,
 *   sessionToken?: string,
 *   id?: string,
 *   forcePathStyle?: boolean,
 *   expiresInSeconds?: number,
 *   timeoutMs?: number,
 * }} config
 * @returns {import('@unitrack/core/types').SourceProvider}
 */
export function createS3SourceProvider({
  endpoint,
  region,
  bucket,
  accessKeyId,
  secretAccessKey,
  sessionToken,
  id = 's3',
  forcePathStyle = true,
  expiresInSeconds = 300,
  timeoutMs = 5000,
}) {
  return {
    id,
    kind: 'object-storage',
    canResolve(ref) {
      return ref.pluginId === id;
    },
    async resolve(ref) {
      // 1. presignGetUrl() for ref.token.token (the object key) — pure
      //    computation, no network call.
      // 2. HEAD the presigned URL — throws on network failure, timeout, or
      //    non-2xx; on success reads Content-Type for ResolvedSource.mime.
    },
    async revalidate(token) {
      // Same presign+HEAD as resolve(), wrapped to return
      // { valid, token, reason? } instead of throwing — identical shape to
      // source-subsonic's revalidate().
    },
  };
}
```

Internally, presigning lives in its own module (mirroring `md5.js`'s
separation in `source-subsonic`):

```js
/**
 * @param {{
 *   endpoint: string, region: string, bucket: string, key: string,
 *   accessKeyId: string, secretAccessKey: string, sessionToken?: string,
 *   forcePathStyle: boolean, expiresInSeconds: number, now: Date,
 * }} params
 * @returns {Promise<string>} the full presigned URL
 */
export async function presignGetUrl(params) { /* ... */ }
```

`now` is an explicit, required parameter (not read from `Date.now()`
internally) specifically so tests can pin it to AWS's worked-example
timestamp and get a byte-identical, reproducible signature — the same
reason `source-subsonic`'s tests control salt generation by asserting on
its *relationship* to the token rather than needing to inject randomness.

**`SourceRef.token.token`** is the S3 object key (e.g.
`music/artist/album/track.flac`) — opaque to `Resolver.js`, exactly as the
Subsonic track id and the local filesystem path already are.

**No dependency injection for `fetch`/`crypto.subtle`.** Both are stable
Node 18+ and browser globals (`source-subsonic` already established this
precedent for `fetch`; `crypto.subtle` is equally standard) — tests run
against a real local `node:http` server, not a mock.

## Error Handling

`resolve()`/`revalidate()`'s shared `HEAD`-check path rejects/returns
`valid: false` with a reason drawn from (checked in order):
1. **Network/timeout** — the `fetch`/`AbortController` rejection surfaced
   as-is, same as `source-subsonic`.
2. **`403`** — `'s3 object access denied (check credentials or expired
   signature)'`.
3. **`404`** — `'s3 object not found'`.
4. **Any other non-2xx** — `` `s3 head failed: HTTP ${status}` ``.

No XML body parsing — see "Why `resolve()` performs a `HEAD`" above for
why there is nothing to parse.

**Redaction.** `secretAccessKey` and `sessionToken` must never appear in a
thrown error message or be logged — the signer only ever uses them to
derive an HMAC digest, never echoes them back. The resulting presigned URL
itself is a **bearer credential for its `expiresInSeconds` window** (unlike
a Subsonic stream URL, whose salt/token pair is tied to a session the
server can independently invalidate) — this is inherent to how presigned
URLs work, not a gap this package can close. The default `expiresInSeconds:
300` keeps that exposure window short; `ResolvedSource.url` is not
currently covered by `CorePlayer`'s existing redaction policy (only
`SourceToken.token` and `ResolvedSource.headers` are — see
`packages/core/src/types.js`), and extending that policy to cover
resolved URLs generically is a larger, cross-cutting change out of scope
for a single provider package. Flagged here as a known, accepted,
documented trade-off rather than a silently-ignored one — worth a future
follow-up if a host's own logging turns out to capture resolved URLs.

## Package

```
packages/plugins/any/source-s3/
├── package.json        — devDependencies: @unitrack/core, @unitrack/conformance-kit,
│                           typescript, @types/node (node:crypto and node:http are used
│                           only by the test suite, to independently cross-check the
│                           production signer and to run a local mock S3 endpoint —
│                           never imported by src/)
├── tsconfig.json
├── tsconfig.build.json
├── src/
│   ├── sigv4.js          — presignGetUrl(), the UriEncode helper, canonical-request/
│   │                        string-to-sign construction, the signing-key HMAC chain
│   └── index.js           — createS3SourceProvider({ endpoint, region, bucket, ... })
└── test/
    ├── helpers/
    │   └── testServer.js  — a real node:http server standing in for an S3-compatible
    │                         endpoint, with test-controlled HEAD responses (200 with a
    │                         Content-Type, 403, 404, hang-forever for the timeout case)
    └── index.test.js
```

Zero runtime dependencies — same posture as `source-local-fs` and
`source-subsonic`. `@unitrack/core` stays a devDependency only.

## Testing

`sigv4.js` (pure, no network):
1. **Reproduces AWS's own published worked example exactly** — the
   `examplebucket`/`test.txt`/`us-east-1`/`20130524T000000Z`/86400s fixture
   from Protocol above, asserting the full presigned URL byte-for-byte
   against AWS's own documented output.
2. **An object key containing a space and a `+`** produces a canonical
   request whose path segment and query values are `UriEncode`d correctly
   (not `encodeURIComponent`'s default behavior) — signature independently
   recomputed via `node:crypto`'s HMAC chain in the test itself (matching
   `source-subsonic`'s "recompute independently via a different code path"
   pattern) rather than trusting the production code's own math.
3. **`forcePathStyle: true` vs `false`** produce the expected
   `{endpoint}/{bucket}/{key}` vs `{scheme}://{bucket}.{host}/{key}` URL
   shapes respectively, with the `Host` header (and therefore the
   signature) computed consistently with whichever style was requested.
4. **`sessionToken`, when present, is included as `X-Amz-Security-Token`**
   in the query string and does not alter `X-Amz-SignedHeaders` (it is a
   query parameter, not a signed header).

`index.js` (against a real local `node:http` server standing in for an
S3-compatible endpoint):
5. **`canResolve`** returns `true` only for a ref targeting this
   provider's configured `id`.
6. **`resolve()` against a healthy `HEAD` (200, `Content-Type` set)**
   returns `{ kind: 'url', mime: <that Content-Type>, url: <presigned URL
   for the requested key> }`.
7. **`resolve()` rejects on `403`** with the access-denied message.
8. **`resolve()` rejects on `404`** with the not-found message.
9. **`resolve()` rejects when the server never responds**, within a small
   configured `timeoutMs` — proves the `AbortController` timeout path
   without a real multi-second wait (mirrors `source-subsonic`'s test #6).
10. **`revalidate()` mirrors `resolve()`'s success/failure mapping**
    (`valid: true` + the same token on 200, `valid: false` + a reason on
    403/404/timeout).
11. **Exposes `{ offline: false, requiresRevalidation: true }` capabilities.**
12. **Runs cleanly through `@unitrack/conformance-kit`'s
    `assertSourceProviderConformance()`** against a `sampleRef` pointed at
    a local test server configured to return a healthy `HEAD`.

## Non-goals

Restated from Scope: bucket listing/browsing, object metadata/tag
fetching, any write path, an SDK-style credential provider chain, and
range-request optimization are all out of scope for this package.
