import { createServer } from 'node:http';

/**
 * Starts a real HTTP server on an ephemeral localhost port for a single
 * test. No mocking library — a real server, matching this project's
 * established practice of writing small, real stand-ins (the DOM stub in
 * @unitrack/engine-web-audio, real temp files in @unitrack/source-local-fs)
 * instead of mocking libraries.
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
 * @param {{ status: 'ok' | 'failed', errorCode?: number, errorMessage?: string }} config
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function pingHandler({ status, errorCode = 40, errorMessage = 'Wrong username or password.' }) {
  return (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const body = status === 'ok'
      ? { 'subsonic-response': { status: 'ok', version: '1.16.1' } }
      : { 'subsonic-response': { status: 'failed', version: '1.16.1', error: { code: errorCode, message: errorMessage } } };
    res.end(JSON.stringify(body));
  };
}
