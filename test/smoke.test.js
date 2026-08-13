import { test } from 'node:test';
import assert from 'node:assert/strict';

test('the test runner executes assertions', () => {
  assert.equal(1 + 1, 2);
});
