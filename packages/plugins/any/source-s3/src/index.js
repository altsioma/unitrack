import { CONTRACT_VERSION } from '@unitrack/core/types';
import { presignGetUrl } from './sigv4.js';

/**
 * HEAD-checks a freshly-presigned URL for `key` — doubles as the
 * reachability/permission check "resolve means confirm playable right
 * now" (see @unitrack/source-subsonic's design spec, restated for this
 * package's own Protocol section) demands, and as a source of a real
 * Content-Type for ResolvedSource.mime. HEAD responses never carry a body
 * (RFC 7231) — including S3's own error responses — so failure messages
 * are derived from the HTTP status code alone; there is no XML body to
 * parse the way a GET error response would have.
 *
 * @param {{
 *   endpoint: string, region: string, bucket: string,
 *   accessKeyId: string, secretAccessKey: string, sessionToken: string | undefined,
 *   forcePathStyle: boolean, expiresInSeconds: number, timeoutMs: number,
 * }} config
 * @param {string} key
 * @returns {Promise<{ url: string, contentType: string }>}
 */
async function headObject(config, key) {
  const {
    endpoint, region, bucket, accessKeyId, secretAccessKey, sessionToken,
    forcePathStyle, expiresInSeconds, timeoutMs,
  } = config;
  const url = await presignGetUrl({
    endpoint, region, bucket, key, accessKeyId, secretAccessKey, sessionToken,
    forcePathStyle, expiresInSeconds, now: new Date(),
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  /** @type {Response} */
  let response;
  try {
    response = await fetch(url, { method: 'HEAD', signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 403) {
    throw new Error('s3 object access denied (check credentials or expired signature)');
  }
  if (response.status === 404) {
    throw new Error('s3 object not found');
  }
  if (!response.ok) {
    throw new Error(`s3 head failed: HTTP ${response.status}`);
  }

  return { url, contentType: response.headers.get('content-type') ?? 'application/octet-stream' };
}

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
  const resolvedConfig = {
    endpoint, region, bucket, accessKeyId, secretAccessKey, sessionToken,
    forcePathStyle, expiresInSeconds, timeoutMs,
  };

  return {
    id,
    kind: 'object-storage',
    contractVersion: CONTRACT_VERSION,

    // Not usable offline — every resolve() is a HEAD round-trip against a
    // freshly-presigned URL. requiresRevalidation is true because the
    // presigned URL embeds a one-time signature that expires after
    // expiresInSeconds — revalidate() below just re-presigns and re-HEADs
    // the same way resolve() does, so a stale/expired link can be retried
    // without the caller needing to know anything S3-specific.
    capabilities: { offline: false, requiresRevalidation: true },

    /**
     * @param {import('@unitrack/core/types').PluginContext} ctx
     * @returns {Promise<void>}
     */
    async initialize(ctx) {},

    /** @returns {Promise<void>} */
    async dispose() {},

    /**
     * @param {import('@unitrack/core/types').SourceRef} ref
     * @returns {Promise<boolean>}
     */
    async canResolve(ref) {
      return ref.pluginId === id;
    },

    /**
     * @param {import('@unitrack/core/types').SourceRef} ref
     * @returns {Promise<import('@unitrack/core/types').ResolvedSource>}
     */
    async resolve(ref) {
      const { url, contentType } = await headObject(resolvedConfig, ref.token.token);
      return { kind: 'url', url, mime: contentType };
    },

    /**
     * @param {import('@unitrack/core/types').SourceToken} token
     * @returns {Promise<import('@unitrack/core/types').RevalidationResult>}
     */
    async revalidate(token) {
      try {
        await headObject(resolvedConfig, token.token);
        return { valid: true, token };
      } catch (err) {
        return { valid: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
