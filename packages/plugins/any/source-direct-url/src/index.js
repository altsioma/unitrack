import { CONTRACT_VERSION } from '@unitrack/core/types';

/**
 * HEAD-checks `url` directly — no presigning/signing step (unlike
 * @unitrack/source-s3's headObject(), the URL passed in is already
 * complete and final; this is that same helper with the presigning step
 * removed). Same status-code-only error mapping, and the same bonus: a
 * real Content-Type for ResolvedSource.mime instead of a placeholder.
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
  if (response.status === 403) {
    throw new Error('direct url access denied');
  }
  if (response.status === 404) {
    throw new Error('direct url not found');
  }
  if (!response.ok) {
    throw new Error(`direct url head failed: HTTP ${response.status}`);
  }
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

    // Not usable offline — every resolve() is a live HEAD round-trip.
    // requiresRevalidation is true even though there is no signature to
    // refresh: a re-HEAD of the same unchanged URL is still a legitimate,
    // useful retry (a transient failure, or the file having come back) —
    // see the design spec's Interface section.
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
      const url = ref.token.token;
      const { contentType } = await headUrl(url, timeoutMs);
      return { kind: 'url', url, mime: contentType };
    },

    /**
     * @param {import('@unitrack/core/types').SourceToken} token
     * @returns {Promise<import('@unitrack/core/types').RevalidationResult>}
     */
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
