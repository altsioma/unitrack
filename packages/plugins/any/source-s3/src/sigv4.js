// AWS Signature Version 4, query-string ("presigned URL") signing style —
// see docs/superpowers/specs/2026-08-20-source-s3-design.md's Protocol
// section for why this style (not header-based signing) was chosen, and
// for why crypto.subtle (not a hand-rolled implementation, unlike
// @unitrack/source-subsonic's md5.js) is the right tool here: SigV4 needs
// only SHA-256/HMAC-SHA256, both directly supported by the standard,
// portable SubtleCrypto API available in Node 18+ and every evergreen
// browser. That also means every function touching crypto.subtle here is
// async — its digest()/importKey()/sign() are all Promise-based.

/**
 * SigV4's UriEncode: RFC 3986 unreserved characters (A-Z a-z 0-9 - _ . ~)
 * pass through unescaped; everything else is percent-encoded as uppercase
 * hex. encodeURIComponent() already does most of this but deliberately
 * leaves `! ' ( ) *` unescaped by default — SigV4 requires those percent-
 * encoded too, and getting this wrong is the single most common bug in
 * from-scratch SigV4 implementations (see spec).
 * @param {string} value
 * @returns {string}
 */
function uriEncode(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/**
 * Canonical URI: each path segment UriEncode'd independently, `/`
 * separators preserved (never encoded).
 * @param {string} path
 * @returns {string}
 */
function canonicalUri(path) {
  return '/' + path.split('/').map(uriEncode).join('/');
}

/**
 * @param {Record<string, string>} params
 * @returns {string}
 */
function canonicalQueryString(params) {
  return Object.keys(params)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(params[k])}`)
    .join('&');
}

/**
 * @param {string} message
 * @returns {Promise<string>} lowercase hex SHA-256 digest
 */
async function sha256Hex(message) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(message));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * @param {Uint8Array | string} key
 * @param {string} message
 * @returns {Promise<Uint8Array>}
 */
async function hmacSha256(key, message) {
  const keyBytes = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    'raw',
    /** @type {BufferSource} */ (keyBytes),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await globalThis.crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(message));
  return new Uint8Array(signature);
}

/**
 * @param {Date} now
 * @returns {string} 'YYYYMMDDTHHMMSSZ'
 */
function formatAmzDate(now) {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

/**
 * Builds a presigned S3 (or S3-compatible) GET URL, valid standalone for
 * `expiresInSeconds` from `now`. Pure computation — makes no network call
 * itself; the caller (@unitrack/source-s3's index.js) is responsible for
 * actually verifying the resulting URL resolves to something playable.
 *
 * @param {{
 *   endpoint: string,
 *   region: string,
 *   bucket: string,
 *   key: string,
 *   accessKeyId: string,
 *   secretAccessKey: string,
 *   sessionToken?: string,
 *   forcePathStyle: boolean,
 *   expiresInSeconds: number,
 *   now: Date,
 * }} params
 * @returns {Promise<string>}
 */
export async function presignGetUrl({
  endpoint,
  region,
  bucket,
  key,
  accessKeyId,
  secretAccessKey,
  sessionToken,
  forcePathStyle,
  expiresInSeconds,
  now,
}) {
  const endpointUrl = new URL(endpoint);
  const host = forcePathStyle ? endpointUrl.host : `${bucket}.${endpointUrl.host}`;
  const path = forcePathStyle ? canonicalUri(`${bucket}/${key}`) : canonicalUri(key);

  const amzDate = formatAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;

  /** @type {Record<string, string>} */
  const queryParams = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresInSeconds),
    'X-Amz-SignedHeaders': 'host',
  };
  if (sessionToken) queryParams['X-Amz-Security-Token'] = sessionToken;

  const canonicalQs = canonicalQueryString(queryParams);
  const canonicalRequest = [
    'GET',
    path,
    canonicalQs,
    `host:${host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = await hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, 's3');
  const kSigning = await hmacSha256(kService, 'aws4_request');
  const signatureBytes = await hmacSha256(kSigning, stringToSign);
  const signature = Array.from(signatureBytes).map((b) => b.toString(16).padStart(2, '0')).join('');

  const scheme = endpointUrl.protocol.replace(':', '');
  return `${scheme}://${host}${path}?${canonicalQs}&X-Amz-Signature=${signature}`;
}
