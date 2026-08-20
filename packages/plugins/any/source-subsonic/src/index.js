import { CONTRACT_VERSION } from '@unitrack/core/types';
import { md5Hex, randomHex } from './md5.js';

const API_VERSION = '1.16.1';

// stream.view?format=raw returns whatever format the file is actually
// stored in on the server — Subsonic's ping/stream API gives no way to
// learn that ahead of time without a separate getSong.view metadata call
// this provider doesn't make.
//
// Deliberately '', not a placeholder MIME string like
// 'application/octet-stream' (which @unitrack/source-local-fs falls back
// to for an unrecognized file extension). Both @unitrack/engine-web-audio
// and @unitrack/engine-audio-queue's canPlay() only treat a *falsy*
// resolved.mime as "unknown, be permissive" (`if (!resolved.mime) return
// true`) — a non-empty placeholder string is checked literally via
// `audio.canPlayType(resolved.mime)`, and every browser reports
// canPlayType('application/octet-stream') === '' (verified directly:
// Chromium reports 'probably'/'maybe' for real audio MIME types like
// audio/mpeg or audio/ogg, but '' for that generic placeholder) — so a
// provider that always returns that specific placeholder, as this one
// used to, is silently never playable through either engine. Caught only
// once this provider was actually wired into a real host with a real
// engine end-to-end (@unitrack/web-demo) for the first time; this
// provider's own design spec had explicitly deferred "demo wiring" as
// out of scope, which is exactly why it went unnoticed until now.
const UNKNOWN_MIME = '';

/**
 * @param {string} password
 * @returns {{ token: string, salt: string }}
 */
function computeAuth(password) {
  const salt = randomHex(12);
  const token = md5Hex(password + salt);
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
  /**
   * @param {import('@unitrack/core/types').SourceRef} ref
   * @returns {Promise<import('@unitrack/core/types').ResolvedSource>}
   */
  async function resolveRef(ref) {
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
      extraParams: { id: ref.token.token, format: 'raw' },
    });
    return { kind: 'url', url: streamUrl.href, mime: UNKNOWN_MIME };
  }

  return {
    id,
    kind: 'self-hosted',
    contractVersion: CONTRACT_VERSION,

    // Not usable offline (every resolve() is a network round-trip to
    // ping.view + a freshly-signed stream.view URL). requiresRevalidation
    // is true because the signed URL embeds a one-time salt/token pair —
    // revalidate() below just re-signs a fresh URL the same way resolve()
    // does, so a stale/expired link can be retried without the caller
    // needing to know anything Subsonic-specific.
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
      return resolveRef(ref);
    },
    /**
     * @param {import('@unitrack/core/types').SourceToken} token
     * @returns {Promise<import('@unitrack/core/types').RevalidationResult>}
     */
    async revalidate(token) {
      try {
        await resolveRef({ pluginId: id, token, kind: 'self-hosted' });
        return { valid: true, token };
      } catch (err) {
        return { valid: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
