// A small, dependency-free MD5 implementation (RFC 1321), used only to
// compute the Subsonic API's legacy `t`/`s` (token/salt) auth pair. This
// exists so @unitrack/source-subsonic has zero node:-specific imports —
// letting it move to packages/plugins/any/ as a genuinely
// platform-agnostic package (browser, Electron, and eventually Capacitor
// all run this identically) — instead of depending on node:crypto's
// createHash('md5'), which is not available outside Node at all. MD5 is
// not used here for anything security-sensitive; it is exactly what the
// Subsonic API itself specifies for this legacy auth scheme, not a choice
// made by this package.
//
// This is a standard bitwise/functional port of the RFC 1321 reference
// algorithm — the same well-known public-domain construction used by
// virtually every from-scratch JS MD5 implementation, adapted here to
// operate directly on UTF-8 bytes via TextEncoder rather than a
// legacy-latin1-string byte model.

/**
 * @param {number} x
 * @param {number} c
 * @returns {number}
 */
function rotl(x, c) {
  return (x << c) | (x >>> (32 - c));
}

const K = new Int32Array([
  -680876936, -389564586, 606105819, -1044525330, -176418897, 1200080426, -1473231341, -45705983,
  1770035416, -1958414417, -42063, -1990404162, 1804603682, -40341101, -1502002290, 1236535329,
  -165796510, -1069501632, 643717713, -373897302, -701558691, 38016083, -660478335, -405537848,
  568446438, -1019803690, -187363961, 1163531501, -1444681467, -51403784, 1735328473, -1926607734,
  -378558, -2022574463, 1839030562, -35309556, -1530992060, 1272893353, -155497632, -1094730640,
  681279174, -358537222, -722521979, 76029189, -640364487, -421815835, 530742520, -995338651,
  -198630844, 1126891415, -1416354905, -57434055, 1700485571, -1894986606, -1051523, -2054922799,
  1873313359, -30611744, -1560198380, 1309151649, -145523070, -1120210379, 718787259, -343485551,
]);

const SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/**
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
function pad(bytes) {
  const bitLength = bytes.length * 8;
  // 1 byte for the 0x80 terminator, then zero-pad until length % 64 === 56,
  // then 8 bytes for the 64-bit little-endian original bit length.
  const paddingLength = ((56 - (bytes.length + 1) % 64) + 64) % 64;
  const out = new Uint8Array(bytes.length + 1 + paddingLength + 8);
  out.set(bytes, 0);
  out[bytes.length] = 0x80;
  const view = new DataView(out.buffer);
  // MD5 defines the length field as a 64-bit count, but no real input here
  // approaches 2^32 bits — the high 32 bits are always 0.
  view.setUint32(out.length - 8, bitLength >>> 0, true);
  view.setUint32(out.length - 4, Math.floor(bitLength / 0x100000000), true);
  return out;
}

/**
 * @param {string} input
 * @returns {string} the 32-character lowercase hex digest
 */
export function md5Hex(input) {
  const message = pad(new TextEncoder().encode(input));
  const view = new DataView(message.buffer);

  let a0 = 0x67452301;
  let b0 = -0x10325477; // 0xefcdab89 as a signed 32-bit int
  let c0 = -0x67452302; // 0x98badcfe
  let d0 = 0x10325476;

  for (let chunkStart = 0; chunkStart < message.length; chunkStart += 64) {
    /** @type {number[]} */
    const M = [];
    for (let j = 0; j < 16; j += 1) {
      M.push(view.getUint32(chunkStart + j * 4, true));
    }

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i += 1) {
      let f;
      let g;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      f = (f + a + K[i] + M[g]) | 0;
      a = d;
      d = c;
      c = b;
      b = (b + rotl(f, SHIFTS[i])) | 0;
    }

    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0 >>> 0, true);
  outView.setUint32(4, b0 >>> 0, true);
  outView.setUint32(8, c0 >>> 0, true);
  outView.setUint32(12, d0 >>> 0, true);

  return Array.from(out).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * A portable, non-cryptographically-critical random hex string generator
 * for the Subsonic salt — uses the standard (not Node-specific)
 * globalThis.crypto.getRandomValues, available in Node 18+, every
 * browser, and Electron/Capacitor's embedded Chromium alike.
 * @param {number} byteLength
 * @returns {string}
 */
export function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
