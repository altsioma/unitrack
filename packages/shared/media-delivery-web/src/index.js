/**
 * @param {string | undefined} url
 * @returns {string}
 */
function redactedOrigin(url) {
  if (!url) return '(no url)';
  try {
    return new URL(url).origin;
  } catch {
    return '(unparsable url)';
  }
}

/**
 * Turns a ResolvedSource into a plain URL a web `<audio>` element can play.
 *
 * When `resolved.headers` is absent (or empty), this is a pure passthrough
 * — `resolved.url` goes straight to `<audio>.src` with no fetch involved,
 * preserving the browser's native (and much cheaper) streaming/range-request
 * media path for the common case.
 *
 * When `resolved.headers` is present, native `<audio>` elements cannot send
 * custom request headers, so instead this fetches the resource directly
 * (forwarding the given headers and abort signal), buffers the response
 * into a Blob, and hands back a `blob:` object URL the element *can* play.
 * The caller is responsible for calling the returned `release()` once that
 * URL is no longer needed, to free the underlying Blob.
 *
 * @param {import('@unitrack/core/types').ResolvedSource} resolved
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<{ url: string, release: () => void }>}
 */
export async function acquireWebMediaUrl(resolved, { signal } = {}) {
  if (!resolved.headers || Object.keys(resolved.headers).length === 0) {
    return { url: /** @type {string} */ (resolved.url), release: () => {} };
  }

  const response = await globalThis.fetch(/** @type {string} */ (resolved.url), {
    headers: resolved.headers,
    signal,
  });

  if (!response.ok) {
    // Sanitized deliberately: never include resolved.headers or any
    // token-derived value here — only the HTTP status, resolved.kind, and
    // a redacted URL origin (no path/query, which may itself carry a
    // token in some deployments).
    throw new Error(
      `acquireWebMediaUrl: fetch failed with status ${response.status} for kind "${resolved.kind}" (${redactedOrigin(resolved.url)})`
    );
  }

  const blob = await response.blob();
  const url = globalThis.URL.createObjectURL(blob);
  let released = false;

  return {
    url,
    release() {
      if (released) return;
      released = true;
      globalThis.URL.revokeObjectURL(url);
    },
  };
}
