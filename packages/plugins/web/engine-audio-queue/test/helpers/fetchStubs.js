/**
 * A minimal fetch()/Response/URL.createObjectURL stand-in for exercising
 * this engine's use of @unitrack/media-delivery-web's acquireWebMediaUrl()
 * end-to-end, without a real network or DOM. Mirrors
 * @unitrack/media-delivery-web's own test/helpers/fetchStubs.js — kept as a
 * small package-local copy rather than a cross-package import, since only a
 * couple of tests here need it.
 */

/**
 * @param {{ ok?: boolean, status?: number, blobValue?: any }} [options]
 * @returns {{ ok: boolean, status: number, blob: () => Promise<any> }}
 */
export function createFakeResponse({ ok = true, status = 200, blobValue = { _fakeBlob: true } } = {}) {
  return {
    ok,
    status,
    async blob() {
      return blobValue;
    },
  };
}

/**
 * @param {{ response?: any, capture?: (url: string, init: any) => void }} [options]
 * @returns {(url: string, init?: any) => Promise<any>}
 */
export function createFakeFetch({ response = createFakeResponse(), capture } = {}) {
  return async function fakeFetch(url, init) {
    if (capture) capture(url, init);
    return response;
  };
}

/**
 * @returns {{ createObjectURL: (blob: any) => string, revokeObjectURL: (url: string) => void, revokedUrls: string[] }}
 */
export function createFakeObjectUrlRegistry() {
  let counter = 0;
  /** @type {string[]} */
  const revokedUrls = [];
  return {
    createObjectURL() {
      counter += 1;
      return `blob:fake-${counter}`;
    },
    revokeObjectURL(url) {
      revokedUrls.push(url);
    },
    revokedUrls,
  };
}

/**
 * Monkey-patches the global fetch/URL.createObjectURL/URL.revokeObjectURL
 * for the duration of `fn`, restoring the originals afterward regardless of
 * outcome — acquireWebMediaUrl() (from @unitrack/media-delivery-web) reads
 * these off `globalThis` directly, with no injection point of its own.
 * @param {{ fetchImpl?: any, urlRegistry?: ReturnType<typeof createFakeObjectUrlRegistry> }} stubs
 * @param {() => Promise<void>} fn
 * @returns {Promise<void>}
 */
export async function withStubbedGlobals({ fetchImpl, urlRegistry }, fn) {
  const originalFetch = globalThis.fetch;
  const originalCreateObjectURL = globalThis.URL.createObjectURL;
  const originalRevokeObjectURL = globalThis.URL.revokeObjectURL;
  if (fetchImpl) globalThis.fetch = fetchImpl;
  if (urlRegistry) {
    globalThis.URL.createObjectURL = urlRegistry.createObjectURL;
    globalThis.URL.revokeObjectURL = urlRegistry.revokeObjectURL;
  }
  try {
    await fn();
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.URL.createObjectURL = originalCreateObjectURL;
    globalThis.URL.revokeObjectURL = originalRevokeObjectURL;
  }
}
