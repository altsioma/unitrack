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
