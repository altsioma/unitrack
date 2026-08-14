import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from '../src/EventEmitter.js';

test('calls a registered handler on emit with the given payload', () => {
  const emitter = new EventEmitter();
  let received;
  emitter.on('foo', (payload) => { received = payload; });
  emitter.emit('foo', 42);
  assert.equal(received, 42);
});

test('supports multiple handlers for the same event, called in order', () => {
  const emitter = new EventEmitter();
  const calls = [];
  emitter.on('foo', () => calls.push('a'));
  emitter.on('foo', () => calls.push('b'));
  emitter.emit('foo');
  assert.deepEqual(calls, ['a', 'b']);
});

test('off removes only the specified handler', () => {
  const emitter = new EventEmitter();
  const calls = [];
  const handlerA = () => calls.push('a');
  const handlerB = () => calls.push('b');
  emitter.on('foo', handlerA);
  emitter.on('foo', handlerB);
  emitter.off('foo', handlerA);
  emitter.emit('foo');
  assert.deepEqual(calls, ['b']);
});

test('emit with no listeners for the event does not throw', () => {
  const emitter = new EventEmitter();
  assert.doesNotThrow(() => emitter.emit('nothing'));
});

test('events are isolated from each other', () => {
  const emitter = new EventEmitter();
  const calls = [];
  emitter.on('foo', () => calls.push('foo'));
  emitter.on('bar', () => calls.push('bar'));
  emitter.emit('foo');
  assert.deepEqual(calls, ['foo']);
});
