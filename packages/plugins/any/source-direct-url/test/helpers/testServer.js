import { createServer } from 'node:http';

/**
 * Starts a real HTTP server on an ephemeral localhost port for a single
 * test, standing in for whatever plain URL this provider is pointed at.
 * No mocking library — matching this project's established practice of
 * writing small, real stand-ins (@unitrack/source-s3's own
 * test/helpers/testServer.js, which this is deliberately a small
 * duplicate of rather than a shared dependency — matches the existing
 * precedent of per-package test helper duplication, e.g. fetchStubs.js in
 * engine-web-audio/engine-audio-queue).
 *
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void} handler
 * @returns {Promise<{ baseUrl: string, close: () => Promise<void> }>}
 */
export function startTestServer(handler) {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (address).port}`,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

/**
 * A handler that responds only to HEAD requests: a 200 with Content-Type
 * set on success, or a bare status code with no body on failure (real
 * HEAD responses never carry a body per RFC 7231 regardless of server —
 * this provider's error messages come from the status code alone).
 * @param {{ status: number, contentType?: string }} config
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function headHandler({ status, contentType }) {
  return (req, res) => {
    const headers = contentType ? { 'Content-Type': contentType } : {};
    res.writeHead(status, headers);
    res.end();
  };
}
