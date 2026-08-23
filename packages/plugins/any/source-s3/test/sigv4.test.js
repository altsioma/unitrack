import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createHash } from 'node:crypto';
import { presignGetUrl } from '../src/sigv4.js';

// AWS's own published worked example ("Authenticating Requests: Using
// Query Parameters (AWS Signature Version 4)" / sigv4-query-string-auth) —
// independently reproduced by hand before this test was written (see the
// design spec's Protocol section). Every literal value below, including
// the expected final URL, comes straight from that documentation.
test('reproduces AWS\'s published worked example exactly (examplebucket/test.txt, virtual-hosted style)', async () => {
  const url = await presignGetUrl({
    endpoint: 'https://s3.amazonaws.com',
    region: 'us-east-1',
    bucket: 'examplebucket',
    key: 'test.txt',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    forcePathStyle: false,
    expiresInSeconds: 86400,
    now: new Date('2013-05-24T00:00:00Z'),
  });
  assert.equal(
    url,
    'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404'
  );
});

/**
 * Independent, from-scratch recomputation of the expected SigV4 signature
 * via node:crypto (not sigv4.js's own helpers) — proves the production
 * implementation is correct via a genuinely different code path, rather
 * than a test that would share a bug with the code it's checking. Mirrors
 * @unitrack/source-subsonic's test of recomputing its MD5 token via
 * node:crypto's createHash independently of source-subsonic's own md5.js.
 * @param {{ host: string, path: string, queryParams: Record<string, string>, secretAccessKey: string, dateStamp: string, region: string, amzDate: string }} p
 */
function expectedSignature({ host, path, queryParams, secretAccessKey, dateStamp, region, amzDate }) {
  const canonicalQs = Object.keys(queryParams).sort()
    .map((k) => `${encodeRfc3986(k)}=${encodeRfc3986(queryParams[k])}`)
    .join('&');
  const canonicalRequest = ['GET', path, canonicalQs, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, credentialScope,
    createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
  ].join('\n');
  const hmac = (key, msg) => createHmac('sha256', key).update(msg, 'utf8').digest();
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  return createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
}

/** @param {string} v */
function encodeRfc3986(v) {
  return encodeURIComponent(v).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

test('a key with a space and a "+" is UriEncode-d correctly (not encodeURIComponent default behavior)', async () => {
  const now = new Date('2020-01-15T12:34:56Z');
  const url = await presignGetUrl({
    endpoint: 'https://s3.amazonaws.com',
    region: 'eu-west-1',
    bucket: 'my-bucket',
    key: 'music/a b+c.flac',
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'secretkey123',
    forcePathStyle: false,
    expiresInSeconds: 300,
    now,
  });
  const parsed = new URL(url);
  // space -> %20 (not '+'), '+' -> %2B: both visible directly in the raw
  // path string (URL's own .pathname getter would re-decode %20 back to a
  // literal space, so assert against the serialized href instead).
  assert.ok(url.includes('/music/a%20b%2Bc.flac'), `expected UriEncode'd path segment in ${url}`);

  const amzDate = '20200115T123456Z';
  const dateStamp = '20200115';
  const expected = expectedSignature({
    host: 'my-bucket.s3.amazonaws.com',
    path: '/music/a%20b%2Bc.flac',
    queryParams: {
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `AKIDEXAMPLE/${dateStamp}/eu-west-1/s3/aws4_request`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': '300',
      'X-Amz-SignedHeaders': 'host',
    },
    secretAccessKey: 'secretkey123',
    dateStamp,
    region: 'eu-west-1',
    amzDate,
  });
  assert.equal(parsed.searchParams.get('X-Amz-Signature'), expected);
});

test('forcePathStyle true vs false produce the expected URL shapes and different (Host-dependent) signatures', async () => {
  const now = new Date('2021-06-01T00:00:00Z');
  const base = {
    endpoint: 'https://minio.example.com:9000',
    region: 'us-east-1',
    bucket: 'my-bucket',
    key: 'track.flac',
    accessKeyId: 'AKID',
    secretAccessKey: 'secret',
    expiresInSeconds: 300,
    now,
  };
  const pathStyleUrl = await presignGetUrl({ ...base, forcePathStyle: true });
  const virtualHostedUrl = await presignGetUrl({ ...base, forcePathStyle: false });

  const pathParsed = new URL(pathStyleUrl);
  assert.equal(pathParsed.host, 'minio.example.com:9000');
  assert.equal(pathParsed.pathname, '/my-bucket/track.flac');

  const vhParsed = new URL(virtualHostedUrl);
  assert.equal(vhParsed.host, 'my-bucket.minio.example.com:9000');
  assert.equal(vhParsed.pathname, '/track.flac');

  assert.notEqual(
    pathParsed.searchParams.get('X-Amz-Signature'),
    vhParsed.searchParams.get('X-Amz-Signature'),
    'the Host used in the canonical request must genuinely participate in the signature'
  );
});

test('sessionToken, when present, is included as X-Amz-Security-Token without affecting X-Amz-SignedHeaders', async () => {
  const now = new Date('2022-03-03T03:03:03Z');
  const withoutToken = await presignGetUrl({
    endpoint: 'https://s3.amazonaws.com', region: 'us-east-1', bucket: 'b', key: 'k',
    accessKeyId: 'AKID', secretAccessKey: 'secret', forcePathStyle: false, expiresInSeconds: 300, now,
  });
  const withToken = await presignGetUrl({
    endpoint: 'https://s3.amazonaws.com', region: 'us-east-1', bucket: 'b', key: 'k',
    accessKeyId: 'AKID', secretAccessKey: 'secret', sessionToken: 'FwoGZXIvYXdz...EXAMPLE',
    forcePathStyle: false, expiresInSeconds: 300, now,
  });

  const withoutParsed = new URL(withoutToken);
  const withParsed = new URL(withToken);
  assert.equal(withoutParsed.searchParams.has('X-Amz-Security-Token'), false);
  assert.equal(withParsed.searchParams.get('X-Amz-Security-Token'), 'FwoGZXIvYXdz...EXAMPLE');
  assert.equal(withParsed.searchParams.get('X-Amz-SignedHeaders'), 'host');
  assert.notEqual(
    withoutParsed.searchParams.get('X-Amz-Signature'),
    withParsed.searchParams.get('X-Amz-Signature'),
    'adding a query param changes the canonical query string and therefore the signature'
  );
});
