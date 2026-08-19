/**
 * A minimal fetch()/Response/URL.createObjectURL stand-in for testing
 * acquireWebMediaUrl() without a real network or DOM — in the same spirit
 * as the two web engine packages' own test/helpers/domStubs.js.
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

/** @returns {Error} */
function makeAbortError() {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * Builds a fake `fetch` implementation. Resolution/rejection happens on a
 * macrotask (setTimeout), not synchronously, so an abort fired by the
 * caller right after invoking fetch() has a real chance to win the race —
 * same as a genuine in-flight network request would.
 * @param {{ response?: any, error?: Error, delayMs?: number, capture?: (url: string, init: any) => void }} [options]
 * @returns {(url: string, init?: any) => Promise<any>}
 */
export function createFakeFetch({ response = createFakeResponse(), error, delayMs = 0, capture } = {}) {
  return function fakeFetch(url, init) {
    if (capture) capture(url, init);
    return new Promise((resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(makeAbortError());
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(makeAbortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve(response);
      }, delayMs);
    });
  };
}

/**
 * A fake URL.createObjectURL/revokeObjectURL registry — hands back
 * deterministic, distinguishable "blob:fake-N" URLs and records every
 * revoke call so tests can assert release() behaviour.
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
