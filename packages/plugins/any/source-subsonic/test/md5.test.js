import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { md5Hex, randomHex } from '../src/md5.js';

// node:crypto's createHash('md5') is only used here, in this package's own
// test suite, as an independent oracle to verify the pure-JS
// implementation in src/md5.js — never imported by src/index.js itself,
// which is the whole point of md5.js existing (see its doc comment).

const RFC1321_VECTORS = [
  ['', 'd41d8cd98f00b204e9800998ecf8427e'],
  ['a', '0cc175b9c0f1b6a831c399e269772661'],
  ['abc', '900150983cd24fb0d6963f7d28e17f72'],
  ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
  ['abcdefghijklmnopqrstuvwxyz', 'c3fcd3d76192e4007dfb496cca67e13b'],
  ['ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 'd174ab98d277d9f5a5611c2c9f419d9f'],
  ['12345678901234567890123456789012345678901234567890123456789012345678901234567890', '57edf4a22be3c955ac49da2e2107b67a'],
];

test('matches the official RFC 1321 test vectors', () => {
  for (const [input, expected] of RFC1321_VECTORS) {
    assert.equal(md5Hex(input), expected, `md5Hex(${JSON.stringify(input)})`);
  }
});

test('matches node:crypto\'s createHash("md5") across message lengths that cross a 64-byte block boundary', () => {
  for (const length of [0, 1, 55, 56, 57, 63, 64, 65, 127, 128, 129, 1000]) {
    const input = 'x'.repeat(length);
    assert.equal(md5Hex(input), createHash('md5').update(input, 'utf8').digest('hex'), `length ${length}`);
  }
});

test('matches node:crypto\'s createHash("md5") for multi-byte UTF-8 input', () => {
  const input = 'юникод тест 你好 🎵';
  assert.equal(md5Hex(input), createHash('md5').update(input, 'utf8').digest('hex'));
});

test('randomHex returns a lowercase hex string of the requested byte length', () => {
  const hex = randomHex(12);
  assert.equal(hex.length, 24);
  assert.match(hex, /^[0-9a-f]+$/);
});

test('randomHex does not repeat across consecutive calls', () => {
  const a = randomHex(12);
  const b = randomHex(12);
  assert.notEqual(a, b);
});
