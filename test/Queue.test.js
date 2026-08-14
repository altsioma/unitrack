import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QueueManager } from '../src/Queue.js';
import { makeTrack } from './helpers/fixtures.js';

test('add appends a single track and returns a queue item with a track reference', () => {
  const queue = new QueueManager();
  const [item] = queue.add(makeTrack('t1'));
  assert.equal(queue.getItems().length, 1);
  assert.equal(item.track.id, 't1');
  assert.equal(typeof item.queueItemId, 'string');
});

test('add assigns a unique queueItemId even for the same track added twice', () => {
  const queue = new QueueManager();
  const [item1] = queue.add(makeTrack('t1'));
  const [item2] = queue.add(makeTrack('t1'));
  assert.notEqual(item1.queueItemId, item2.queueItemId);
});

test('add accepts an array of tracks', () => {
  const queue = new QueueManager();
  const items = queue.add([makeTrack('t1'), makeTrack('t2')]);
  assert.equal(items.length, 2);
  assert.equal(queue.getItems().length, 2);
});

test('getItems returns a copy, not the live internal array', () => {
  const queue = new QueueManager();
  queue.add(makeTrack('t1'));
  const items = queue.getItems();
  items.pop();
  assert.equal(queue.getItems().length, 1);
});

test('remove deletes an item by queueItemId and returns true', () => {
  const queue = new QueueManager();
  const [item] = queue.add(makeTrack('t1'));
  assert.equal(queue.remove(item.queueItemId), true);
  assert.equal(queue.getItems().length, 0);
});

test('remove returns false for an unknown queueItemId', () => {
  const queue = new QueueManager();
  assert.equal(queue.remove('does-not-exist'), false);
});

test('removing an item before the current index shifts the current index left', () => {
  const queue = new QueueManager();
  const [a] = queue.add([makeTrack('a'), makeTrack('b')]);
  queue.setCurrentIndex(1);
  queue.remove(a.queueItemId);
  assert.equal(queue.getCurrentItem().track.id, 'b');
  assert.equal(queue.getCurrentIndex(), 0);
});

test('removing the last remaining item resets the current index to -1', () => {
  const queue = new QueueManager();
  const [a] = queue.add(makeTrack('a'));
  queue.setCurrentIndex(0);
  queue.remove(a.queueItemId);
  assert.equal(queue.getCurrentIndex(), -1);
  assert.equal(queue.getCurrentItem(), undefined);
});

test('reorder moves an item to a new index and keeps tracking the current item', () => {
  const queue = new QueueManager();
  const [a, , c] = queue.add([makeTrack('a'), makeTrack('b'), makeTrack('c')]);
  queue.setCurrentIndex(2);
  queue.reorder(a.queueItemId, 2);
  assert.deepEqual(queue.getItems().map((i) => i.track.id), ['b', 'c', 'a']);
  assert.equal(queue.getCurrentItem().track.id, 'c');
});

test('reorder returns false for an unknown queueItemId', () => {
  const queue = new QueueManager();
  queue.add(makeTrack('a'));
  assert.equal(queue.reorder('does-not-exist', 0), false);
});

test('clear empties the queue and resets the current index', () => {
  const queue = new QueueManager();
  queue.add([makeTrack('a'), makeTrack('b')]);
  queue.setCurrentIndex(1);
  queue.clear();
  assert.equal(queue.getItems().length, 0);
  assert.equal(queue.getCurrentIndex(), -1);
});

test('moveNext advances the current index and returns true', () => {
  const queue = new QueueManager();
  queue.add([makeTrack('a'), makeTrack('b')]);
  assert.equal(queue.moveNext(), true);
  assert.equal(queue.getCurrentItem().track.id, 'a');
  assert.equal(queue.moveNext(), true);
  assert.equal(queue.getCurrentItem().track.id, 'b');
});

test('moveNext returns false at the end of the queue and does not move', () => {
  const queue = new QueueManager();
  queue.add(makeTrack('a'));
  queue.moveNext();
  assert.equal(queue.moveNext(), false);
  assert.equal(queue.getCurrentItem().track.id, 'a');
});

test('movePrevious retreats the current index and returns true', () => {
  const queue = new QueueManager();
  queue.add([makeTrack('a'), makeTrack('b')]);
  queue.setCurrentIndex(1);
  assert.equal(queue.movePrevious(), true);
  assert.equal(queue.getCurrentItem().track.id, 'a');
});

test('movePrevious returns false at the start of the queue', () => {
  const queue = new QueueManager();
  queue.add(makeTrack('a'));
  queue.setCurrentIndex(0);
  assert.equal(queue.movePrevious(), false);
});

test('setCurrentIndex throws a RangeError for an out-of-bounds index', () => {
  const queue = new QueueManager();
  queue.add(makeTrack('a'));
  assert.throws(() => queue.setCurrentIndex(5), RangeError);
  assert.throws(() => queue.setCurrentIndex(-2), RangeError);
});

test('setCurrentIndex(-1) is valid and clears the current item', () => {
  const queue = new QueueManager();
  queue.add(makeTrack('a'));
  queue.setCurrentIndex(0);
  queue.setCurrentIndex(-1);
  assert.equal(queue.getCurrentItem(), undefined);
});

test('emits changed only when an operation actually mutates the queue', () => {
  const queue = new QueueManager();
  let fired = 0;
  queue.on('changed', () => { fired += 1; });
  const [item] = queue.add(makeTrack('a'));
  queue.add(makeTrack('b'));
  queue.moveNext();
  // movePrevious() is a no-op here (already at index 0) — it must not emit.
  queue.movePrevious();
  queue.setCurrentIndex(1);
  queue.reorder(item.queueItemId, 1);
  queue.remove(item.queueItemId);
  queue.clear();
  assert.equal(fired, 7);
});
