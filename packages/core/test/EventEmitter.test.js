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

test('a throwing handler does not prevent later handlers for the same event from running', () => {
  const emitter = new EventEmitter();
  const calls = [];
  emitter.on('foo', () => { throw new Error('first handler is broken'); });
  emitter.on('foo', () => calls.push('second ran'));
  assert.throws(() => emitter.emit('foo'));
  assert.deepEqual(calls, ['second ran']);
});

test('emit throws an AggregateError containing every handler that threw, after all handlers have run', () => {
  const emitter = new EventEmitter();
  const errA = new Error('a broke');
  const errB = new Error('b broke');
  const calls = [];
  emitter.on('foo', () => { calls.push('a'); throw errA; });
  emitter.on('foo', () => { calls.push('b'); throw errB; });
  emitter.on('foo', () => calls.push('c'));

  assert.throws(() => emitter.emit('foo'), (err) => {
    assert.ok(err instanceof AggregateError);
    assert.deepEqual(err.errors, [errA, errB]);
    return true;
  });
  assert.deepEqual(calls, ['a', 'b', 'c']);
});

test('emit does not throw when no handler throws', () => {
  const emitter = new EventEmitter();
  emitter.on('foo', () => {});
  emitter.on('foo', () => {});
  assert.doesNotThrow(() => emitter.emit('foo'));
});
