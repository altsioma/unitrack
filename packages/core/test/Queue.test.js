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

test('isShuffleEnabled defaults to false; setShuffle toggles it', () => {
  const queue = new QueueManager();
  assert.equal(queue.isShuffleEnabled(), false);
  queue.setShuffle(true);
  assert.equal(queue.isShuffleEnabled(), true);
  queue.setShuffle(false);
  assert.equal(queue.isShuffleEnabled(), false);
});

test('getRepeatMode defaults to "off"; setRepeatMode round-trips', () => {
  const queue = new QueueManager();
  assert.equal(queue.getRepeatMode(), 'off');
  queue.setRepeatMode('all');
  assert.equal(queue.getRepeatMode(), 'all');
  queue.setRepeatMode('one');
  assert.equal(queue.getRepeatMode(), 'one');
});

test('turning shuffle on with a track already current does not change the current item', () => {
  const queue = new QueueManager();
  queue.add([makeTrack('a'), makeTrack('b'), makeTrack('c')]);
  queue.setCurrentIndex(1);
  queue.setShuffle(true);
  assert.equal(queue.getCurrentIndex(), 1);
  assert.equal(queue.getCurrentItem().track.id, 'b');
});

test('shuffle: moveNext from the start visits every remaining item exactly once (no repeats, full coverage)', () => {
  for (let trial = 0; trial < 20; trial++) {
    const queue = new QueueManager();
    const items = queue.add([makeTrack('a'), makeTrack('b'), makeTrack('c'), makeTrack('d'), makeTrack('e')]);
    queue.setCurrentIndex(0);
    queue.setShuffle(true);
    const visited = new Set([0]);
    for (let i = 0; i < items.length - 1; i++) {
      assert.equal(queue.moveNext(), true);
      visited.add(queue.getCurrentIndex());
    }
    assert.equal(visited.size, items.length);
  }
});

test('shuffle: moveNext returns false once every item has been visited (repeat off)', () => {
  const queue = new QueueManager();
  const items = queue.add([makeTrack('a'), makeTrack('b'), makeTrack('c')]);
  queue.setCurrentIndex(0);
  queue.setShuffle(true);
  for (let i = 0; i < items.length - 1; i++) {
    assert.equal(queue.moveNext(), true);
  }
  assert.equal(queue.moveNext(), false);
});

test('shuffle: movePrevious retraces real play history, not a new random pick', () => {
  for (let trial = 0; trial < 20; trial++) {
    const queue = new QueueManager();
    queue.add([makeTrack('a'), makeTrack('b'), makeTrack('c'), makeTrack('d')]);
    queue.setCurrentIndex(0);
    queue.setShuffle(true);
    const before = queue.getCurrentIndex();
    queue.moveNext();
    assert.equal(queue.movePrevious(), true);
    assert.equal(queue.getCurrentIndex(), before);
  }
});

test('shuffle: movePrevious returns false at the start of history', () => {
  const queue = new QueueManager();
  queue.add([makeTrack('a'), makeTrack('b')]);
  queue.setCurrentIndex(0);
  queue.setShuffle(true);
  assert.equal(queue.movePrevious(), false);
});

test('shuffle: after moving back, moveNext redoes the same forward step (no new random pick) until history diverges', () => {
  const queue = new QueueManager();
  queue.add([makeTrack('a'), makeTrack('b'), makeTrack('c')]);
  queue.setCurrentIndex(0);
  queue.setShuffle(true);
  queue.moveNext();
  const afterFirstNext = queue.getCurrentIndex();
  queue.movePrevious();
  queue.moveNext();
  assert.equal(queue.getCurrentIndex(), afterFirstNext);
});

test('linear: repeat "all" wraps moveNext to index 0 at the end of the queue', () => {
  const queue = new QueueManager();
  queue.add([makeTrack('a'), makeTrack('b')]);
  queue.setCurrentIndex(1);
  queue.setRepeatMode('all');
  assert.equal(queue.moveNext(), true);
  assert.equal(queue.getCurrentIndex(), 0);
});

test('linear: repeat "off" still returns false at the end of the queue (unchanged default)', () => {
  const queue = new QueueManager();
  queue.add([makeTrack('a'), makeTrack('b')]);
  queue.setCurrentIndex(1);
  assert.equal(queue.moveNext(), false);
});

test('repeat "all" never wraps movePrevious backward at the start (linear mode)', () => {
  const queue = new QueueManager();
  queue.add([makeTrack('a'), makeTrack('b')]);
  queue.setCurrentIndex(0);
  queue.setRepeatMode('all');
  assert.equal(queue.movePrevious(), false);
});

test('repeat "all" never wraps movePrevious backward at the start of shuffle history', () => {
  const queue = new QueueManager();
  queue.add([makeTrack('a'), makeTrack('b')]);
  queue.setCurrentIndex(0);
  queue.setRepeatMode('all');
  queue.setShuffle(true);
  assert.equal(queue.movePrevious(), false);
});

test('shuffle + repeat "all": moveNext starts a new cycle instead of returning false once exhausted', () => {
  const queue = new QueueManager();
  const items = queue.add([makeTrack('a'), makeTrack('b'), makeTrack('c')]);
  queue.setCurrentIndex(0);
  queue.setShuffle(true);
  queue.setRepeatMode('all');
  // 3x the queue length of consecutive successful moveNext() calls proves
  // it keeps cycling well past exhausting the queue once.
  for (let i = 0; i < items.length * 3; i++) {
    assert.equal(queue.moveNext(), true, `moveNext() call #${i + 1} should still succeed under repeat:'all'`);
  }
});

test('shuffle + repeat "all" with a single item: the same item repeats instead of stalling', () => {
  const queue = new QueueManager();
  queue.add(makeTrack('a'));
  queue.setCurrentIndex(0);
  queue.setShuffle(true);
  queue.setRepeatMode('all');
  for (let i = 0; i < 5; i++) {
    assert.equal(queue.moveNext(), true);
    assert.equal(queue.getCurrentItem().track.id, 'a');
  }
});

test('shuffle: remove() mid-shuffle resets history (no stale index) and moveNext still lands on a real item', () => {
  for (let trial = 0; trial < 10; trial++) {
    const queue = new QueueManager();
    const items = queue.add([makeTrack('a'), makeTrack('b'), makeTrack('c'), makeTrack('d')]);
    queue.setCurrentIndex(0);
    queue.setShuffle(true);
    queue.moveNext();
    const currentItemBeforeRemove = queue.getCurrentItem();
    // Remove an item that is deliberately NOT the currently-playing one —
    // moveNext() picked randomly, so pick whichever queue item isn't it.
    const toRemove = items.find((i) => i.queueItemId !== currentItemBeforeRemove.queueItemId);
    queue.remove(toRemove.queueItemId);
    // remove() deliberately resets shuffle history (a queue-shape change
    // invalidates "already played" bookkeeping) — so there's legitimately
    // nothing to go back to immediately after, and movePrevious() should
    // say so rather than landing on a stale/incorrect index.
    assert.equal(queue.movePrevious(), false);
    assert.equal(queue.getCurrentItem().track.id, currentItemBeforeRemove.track.id);
    assert.equal(queue.moveNext(), true);
    const validIds = queue.getItems().map((i) => i.track.id);
    assert.ok(validIds.includes(queue.getCurrentItem().track.id));
  }
});

test('shuffle: reorder() mid-shuffle leaves moveNext/movePrevious landing on real, valid items', () => {
  const queue = new QueueManager();
  const items = queue.add([makeTrack('a'), makeTrack('b'), makeTrack('c')]);
  queue.setCurrentIndex(0);
  queue.setShuffle(true);
  queue.reorder(items[2].queueItemId, 0);
  assert.equal(queue.getCurrentItem().track.id, 'a');
  assert.equal(queue.moveNext(), true);
  const validIds = queue.getItems().map((i) => i.track.id);
  assert.ok(validIds.includes(queue.getCurrentItem().track.id));
  assert.equal(queue.movePrevious(), true);
  assert.equal(queue.getCurrentItem().track.id, 'a');
});

test('setShuffle and setRepeatMode emit changed only when they actually change the value', () => {
  const queue = new QueueManager();
  let fired = 0;
  queue.on('changed', () => { fired += 1; });
  queue.setShuffle(true);
  queue.setShuffle(true); // no-op, same value — must not emit
  queue.setRepeatMode('all');
  queue.setRepeatMode('all'); // no-op, same value — must not emit
  assert.equal(fired, 2);
});
