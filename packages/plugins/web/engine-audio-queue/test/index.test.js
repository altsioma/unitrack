import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAudioQueuePlaybackEngine } from '../src/index.js';
import { createFakeAudioConstructor, flush } from './helpers/domStubs.js';

/**
 * @param {string} queueItemId
 * @param {string} url
 * @returns {{ queueItemId: string, resolved: import('@unitrack/core/types').ResolvedSource }}
 */
function entry(queueItemId, url) {
  return { queueItemId, resolved: { kind: 'url', url, mime: 'audio/mpeg' } };
}

test('capabilities declare queueAuthority: "engine" and gapless: true', () => {
  const AudioConstructor = createFakeAudioConstructor();
  const engine = createAudioQueuePlaybackEngine({ AudioConstructor });
  assert.deepEqual(engine.capabilities, { gapless: true, backgroundPlayback: false, queueAuthority: 'engine' });
});

test('initialize resolves without throwing', async () => {
  const AudioConstructor = createFakeAudioConstructor();
  const engine = createAudioQueuePlaybackEngine({ AudioConstructor });
  await assert.doesNotReject(() => engine.initialize({}));
});

test('dispose pauses both slot elements', async () => {
  const AudioConstructor = createFakeAudioConstructor();
  const engine = createAudioQueuePlaybackEngine({ AudioConstructor });
  const p = engine.setPlaybackPlan([entry('q1', 'file:///a.mp3')]);
  AudioConstructor.instances[0]._simulateCanPlay(100);
  await p;
  await engine.play();
  assert.equal(AudioConstructor.instances[0].paused, false);

  await engine.dispose();

  assert.equal(AudioConstructor.instances[0].paused, true);
});

test('setPlaybackPlan loads the first entry into the active slot and pre-buffers the second into the other slot, without starting playback', async () => {
  const AudioConstructor = createFakeAudioConstructor();
  const engine = createAudioQueuePlaybackEngine({ AudioConstructor });

  const p = engine.setPlaybackPlan([entry('q1', 'file:///a.mp3'), entry('q2', 'file:///b.mp3')]);
  AudioConstructor.instances[0]._simulateCanPlay(100);
  await flush();
  assert.equal(AudioConstructor.instances[1].src, 'file:///b.mp3', 'the second slot has already started loading the next entry');
  AudioConstructor.instances[1]._simulateCanPlay(90);
  await p;

  assert.equal(AudioConstructor.instances[0].src, 'file:///a.mp3');
  assert.equal(AudioConstructor.instances[0].paused, true, 'setPlaybackPlan does not itself start playback');
  assert.equal(AudioConstructor.instances[1].paused, true);
});

test('a single-entry plan leaves the other slot untouched', async () => {
  const AudioConstructor = createFakeAudioConstructor();
  const engine = createAudioQueuePlaybackEngine({ AudioConstructor });

  const p = engine.setPlaybackPlan([entry('q1', 'file:///a.mp3')]);
  AudioConstructor.instances[0]._simulateCanPlay(100);
  await p;

  assert.equal(AudioConstructor.instances[1].loadCalls, 0);
});

test('play() starts the active slot', async () => {
  const AudioConstructor = createFakeAudioConstructor();
  const engine = createAudioQueuePlaybackEngine({ AudioConstructor });
  const p = engine.setPlaybackPlan([entry('q1', 'file:///a.mp3')]);
  AudioConstructor.instances[0]._simulateCanPlay(100);
  await p;

  await engine.play();

  assert.equal(AudioConstructor.instances[0].playCalls, 1);
  assert.equal(AudioConstructor.instances[0].paused, false);
});

test('a ready pre-buffered next entry hands off with a plain play() when the active slot ends — no reload', async () => {
  const AudioConstructor = createFakeAudioConstructor();
  const engine = createAudioQueuePlaybackEngine({ AudioConstructor });

  const p = engine.setPlaybackPlan([entry('q1', 'file:///a.mp3'), entry('q2', 'file:///b.mp3')]);
  AudioConstructor.instances[0]._simulateCanPlay(100);
  await flush();
  AudioConstructor.instances[1]._simulateCanPlay(90);
  await p;
  await engine.play();

  const trackChanged = [];
  const ended = [];
  engine.on('trackChanged', (payload) => trackChanged.push(payload));
  engine.on('ended', () => ended.push(true));

  AudioConstructor.instances[0]._simulateEnded();

  assert.deepEqual(trackChanged, [{ queueItemId: 'q2' }]);
  assert.deepEqual(ended, []);
  assert.equal(AudioConstructor.instances[1].loadCalls, 1, 'the pre-buffered slot was never reloaded on hand-off');
  assert.equal(AudioConstructor.instances[1].playCalls, 1);
});

test('the active slot ending with nothing pre-buffered and ready reports "ended", not "trackChanged"', async () => {
  const AudioConstructor = createFakeAudioConstructor();
  const engine = createAudioQueuePlaybackEngine({ AudioConstructor });

  const p = engine.setPlaybackPlan([entry('q1', 'file:///a.mp3')]);
  AudioConstructor.instances[0]._simulateCanPlay(100);
  await p;
  await engine.play();

  const trackChanged = [];
  const ended = [];
  engine.on('trackChanged', (payload) => trackChanged.push(payload));
  engine.on('ended', () => ended.push(true));

  AudioConstructor.instances[0]._simulateEnded();

  assert.deepEqual(ended, [true]);
  assert.deepEqual(trackChanged, []);
});

test('the active slot ending before the pre-buffered next entry has finished loading reports "ended" rather than handing off to an unready element', async () => {
  const AudioConstructor = createFakeAudioConstructor();
  const engine = createAudioQueuePlaybackEngine({ AudioConstructor });

  // setPlaybackPlan() itself only resolves once both slots have settled —
  // do not await it here, since the whole point of this test is to fire
  // 'ended' while the second slot's load is still genuinely in flight.
  // play() is independent of that (it only touches the already-ready
  // active slot), so it can be awaited on its own.
  const p = engine.setPlaybackPlan([entry('q1', 'file:///a.mp3'), entry('q2', 'file:///b.mp3')]);
  AudioConstructor.instances[0]._simulateCanPlay(100);
  await flush();
  await engine.play();

  const ended = [];
  const trackChanged = [];
  engine.on('ended', () => ended.push(true));
  engine.on('trackChanged', (payload) => trackChanged.push(payload));

  AudioConstructor.instances[0]._simulateEnded();

  assert.deepEqual(ended, [true]);
  assert.deepEqual(trackChanged, []);

  // Let the still-in-flight pre-buffer settle so this test doesn't leave a
  // dangling unsettled promise behind for later tests.
  AudioConstructor.instances[1]._simulateCanPlay(50);
  await p;
});

test('after a hand-off, the freed slot is reset and re-armed with the plan\'s new next entry', async () => {
  const AudioConstructor = createFakeAudioConstructor();
  const engine = createAudioQueuePlaybackEngine({ AudioConstructor });

  const p1 = engine.setPlaybackPlan([entry('q1', 'file:///a.mp3'), entry('q2', 'file:///b.mp3'), entry('q3', 'file:///c.mp3')]);
  AudioConstructor.instances[0]._simulateCanPlay(100);
  await flush();
  AudioConstructor.instances[1]._simulateCanPlay(90);
  await p1;
  await engine.play();

  AudioConstructor.instances[0]._simulateEnded();
  await flush();

  // instances[0] (the now-freed former active slot) should have been
  // reset and re-armed with q3, the plan's new second entry.
  assert.equal(AudioConstructor.instances[0].src, 'file:///c.mp3');
});

test('progress and error events are only forwarded from the currently active slot', async () => {
  const AudioConstructor = createFakeAudioConstructor();
  const engine = createAudioQueuePlaybackEngine({ AudioConstructor });

  const p = engine.setPlaybackPlan([entry('q1', 'file:///a.mp3'), entry('q2', 'file:///b.mp3')]);
  AudioConstructor.instances[0]._simulateCanPlay(100);
  await flush();
  AudioConstructor.instances[1]._simulateCanPlay(90);
  await p;
  await engine.play();

  const progress = [];
  engine.on('progress', (payload) => progress.push(payload));

  AudioConstructor.instances[1]._simulateTimeUpdate(5); // inactive slot — must not forward
  assert.deepEqual(progress, []);

  AudioConstructor.instances[0]._simulateTimeUpdate(12); // active slot — must forward
  assert.deepEqual(progress, [{ position: 12, duration: 100 }]);
});

test('a media error on the active slot outside of a load() is forwarded as "error"', async () => {
  const AudioConstructor = createFakeAudioConstructor();
  const engine = createAudioQueuePlaybackEngine({ AudioConstructor });
  const p = engine.setPlaybackPlan([entry('q1', 'file:///a.mp3')]);
  AudioConstructor.instances[0]._simulateCanPlay(100);
  await p;
  await engine.play();

  const errors = [];
  engine.on('error', (err) => errors.push(err));

  AudioConstructor.instances[0]._simulateError(2);

  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /MEDIA_ERR_NETWORK/);
});

test('setPlaybackPlan rejects when the active slot\'s load fails, and does not also emit a steady-state "error"', async () => {
  const AudioConstructor = createFakeAudioConstructor();
  const engine = createAudioQueuePlaybackEngine({ AudioConstructor });

  const errors = [];
  engine.on('error', (err) => errors.push(err));

  const p = engine.setPlaybackPlan([entry('q1', 'file:///a.mp3')]);
  AudioConstructor.instances[0]._simulateError(4);

  await assert.rejects(() => p, /MEDIA_ERR_SRC_NOT_SUPPORTED/);
  assert.deepEqual(errors, [], 'the in-flight load\'s own rejection is enough — no duplicate "error" event');
});

test('setPlaybackPlan called again with the same current entry does not reload the active slot', async () => {
  const AudioConstructor = createFakeAudioConstructor();
  const engine = createAudioQueuePlaybackEngine({ AudioConstructor });

  const p1 = engine.setPlaybackPlan([entry('q1', 'file:///a.mp3')]);
  AudioConstructor.instances[0]._simulateCanPlay(100);
  await p1;
  assert.equal(AudioConstructor.instances[0].loadCalls, 1);

  // Simulates CorePlayer#refreshLookaheadPlan re-pushing a plan that still
  // starts at the same current item (e.g. after a queue mutation).
  const p2 = engine.setPlaybackPlan([entry('q1', 'file:///a.mp3'), entry('q2', 'file:///b.mp3')]);
  await flush();
  AudioConstructor.instances[1]._simulateCanPlay(50);
  await p2;

  assert.equal(AudioConstructor.instances[0].loadCalls, 1, 'the already-loaded active slot was not reloaded');
});

test('canPlay checks the active slot\'s canPlayType for a known mime type', async () => {
  const AudioConstructor = createFakeAudioConstructor();
  const engine = createAudioQueuePlaybackEngine({ AudioConstructor });
  AudioConstructor.instances[0]._canPlayTypeResult = '';

  assert.equal(await engine.canPlay({ kind: 'url', url: 'file:///a.mp3', mime: 'audio/mpeg' }), false);
  assert.equal(await engine.canPlay({ kind: 'url', url: 'file:///a.flac', mime: '' }), true, 'no mime given is treated as playable');
});

test('canPlay returns false for a non-url kind — this engine only supports kind: "url"', async () => {
  const AudioConstructor = createFakeAudioConstructor();
  const engine = createAudioQueuePlaybackEngine({ AudioConstructor });
  assert.equal(await engine.canPlay({ kind: 'buffer', buffer: new ArrayBuffer(0), mime: 'audio/mpeg' }), false);
});

test('setVolume applies to both slots so a hand-off does not audibly change volume; getVolume reads the active slot', async () => {
  const AudioConstructor = createFakeAudioConstructor();
  const engine = createAudioQueuePlaybackEngine({ AudioConstructor });
  const p = engine.setPlaybackPlan([entry('q1', 'file:///a.mp3'), entry('q2', 'file:///b.mp3')]);
  AudioConstructor.instances[0]._simulateCanPlay(100);
  await flush();
  AudioConstructor.instances[1]._simulateCanPlay(90);
  await p;

  engine.setVolume(0.4);

  assert.equal(AudioConstructor.instances[0].volume, 0.4);
  assert.equal(AudioConstructor.instances[1].volume, 0.4);
  assert.equal(engine.getVolume(), 0.4);
});

test('setVolume clamps to [0, 1] and ignores non-finite input', async () => {
  const AudioConstructor = createFakeAudioConstructor();
  const engine = createAudioQueuePlaybackEngine({ AudioConstructor });
  engine.setVolume(2);
  assert.equal(engine.getVolume(), 1);
  engine.setVolume(-1);
  assert.equal(engine.getVolume(), 0);
  engine.setVolume(0.6);
  engine.setVolume(NaN);
  assert.equal(engine.getVolume(), 0.6);
});

test('pause, stop, and seek delegate to the active slot', async () => {
  const AudioConstructor = createFakeAudioConstructor();
  const engine = createAudioQueuePlaybackEngine({ AudioConstructor });
  const p = engine.setPlaybackPlan([entry('q1', 'file:///a.mp3')]);
  AudioConstructor.instances[0]._simulateCanPlay(100);
  await p;
  await engine.play();

  await engine.pause();
  assert.equal(AudioConstructor.instances[0].paused, true);

  await engine.play();
  await engine.stop();
  assert.equal(AudioConstructor.instances[0].paused, true);
  assert.equal(AudioConstructor.instances[0].currentTime, 0);

  await engine.seek(42);
  assert.equal(AudioConstructor.instances[0].currentTime, 42);
});

test('getState reports the active slot\'s position, duration, and buffering', async () => {
  const AudioConstructor = createFakeAudioConstructor();
  const engine = createAudioQueuePlaybackEngine({ AudioConstructor });
  const p = engine.setPlaybackPlan([entry('q1', 'file:///a.mp3')]);
  AudioConstructor.instances[0]._simulateCanPlay(180);
  await p;

  AudioConstructor.instances[0]._simulateWaiting();
  assert.equal(engine.getState().buffering, true);

  AudioConstructor.instances[0]._simulateTimeUpdate(33);
  const state = engine.getState();
  assert.equal(state.position, 33);
  assert.equal(state.duration, 180);
});

test('load() loads a single ResolvedSource into the active slot directly, bypassing plan tracking', async () => {
  const AudioConstructor = createFakeAudioConstructor();
  const engine = createAudioQueuePlaybackEngine({ AudioConstructor });

  const p = engine.load({ kind: 'url', url: 'file:///standalone.mp3', mime: 'audio/mpeg' });
  AudioConstructor.instances[0]._simulateCanPlay(20);
  await p;

  assert.equal(AudioConstructor.instances[0].src, 'file:///standalone.mp3');
});

test('off() removes a registered listener so it no longer receives fired events', async () => {
  const AudioConstructor = createFakeAudioConstructor();
  const engine = createAudioQueuePlaybackEngine({ AudioConstructor });
  const errors = [];
  const handler = (err) => errors.push(err);
  engine.on('error', handler);

  const p = engine.setPlaybackPlan([entry('q1', 'file:///a.mp3')]);
  AudioConstructor.instances[0]._simulateCanPlay(10);
  await p;

  engine.off('error', handler);
  AudioConstructor.instances[0]._simulateError(2);
  assert.equal(errors.length, 0);
});

test('off() is a no-op for a handler that was never registered', () => {
  const AudioConstructor = createFakeAudioConstructor();
  const engine = createAudioQueuePlaybackEngine({ AudioConstructor });
  assert.doesNotThrow(() => engine.off('progress', () => {}));
  assert.doesNotThrow(() => engine.off('transportCommand', () => {}));
});
