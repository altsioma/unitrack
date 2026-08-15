import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { createWebAudioPlaybackEngine } from '../src/index.js';
import { createFakeAudioElement, createFakeAudioContext, asConstructor } from './helpers/domStubs.js';

/**
 * @param {any} [audio]
 * @param {any} [audioContext]
 */
function makeEngine(audio = createFakeAudioElement(), audioContext = createFakeAudioContext()) {
  return {
    engine: createWebAudioPlaybackEngine({
      AudioConstructor: asConstructor(audio),
      AudioContextConstructor: asConstructor(audioContext),
    }),
    audio,
    audioContext,
  };
}

test('has the web-audio id', () => {
  const { engine } = makeEngine();
  assert.equal(engine.id, 'web-audio');
});

test('canPlay returns true for a format the browser reports as playable', () => {
  const audio = createFakeAudioElement();
  audio._canPlayTypeResult = 'probably';
  const { engine } = makeEngine(audio);
  assert.equal(engine.canPlay({ url: 'file:///a.mp3', format: 'mp3' }), true);
});

test('canPlay returns false for a mapped format the browser cannot play', () => {
  const audio = createFakeAudioElement();
  audio._canPlayTypeResult = '';
  const { engine } = makeEngine(audio);
  assert.equal(engine.canPlay({ url: 'file:///a.mp3', format: 'mp3' }), false);
});

test('canPlay returns true for an unmapped or missing format', () => {
  const { engine } = makeEngine();
  assert.equal(engine.canPlay({ url: 'file:///a.xyz', format: 'xyz' }), true);
  assert.equal(engine.canPlay({ url: 'file:///a' }), true);
});

test('load sets the audio src and resolves once canplay fires', async () => {
  const audio = createFakeAudioElement();
  const { engine } = makeEngine(audio);
  const loadPromise = engine.load({ url: 'file:///song.flac', format: 'flac' });
  assert.equal(audio.src, 'file:///song.flac');
  audio._simulateCanPlay(120);
  await loadPromise;
});

test('load rejects with a mapped error message when the element errors', async () => {
  const audio = createFakeAudioElement();
  const { engine } = makeEngine(audio);
  const loadPromise = engine.load({ url: 'file:///broken.mp3' });
  audio._simulateError(4);
  await assert.rejects(
    () => loadPromise,
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /MEDIA_ERR_SRC_NOT_SUPPORTED/);
      return true;
    }
  );
});

test('play calls through to the audio element', async () => {
  const audio = createFakeAudioElement();
  const { engine } = makeEngine(audio);
  await engine.play();
  assert.equal(audio.paused, false);
});

test('pause calls through to the audio element', async () => {
  const audio = createFakeAudioElement();
  const { engine } = makeEngine(audio);
  await engine.play();
  await engine.pause();
  assert.equal(audio.paused, true);
});

test('stop pauses and resets position to 0', async () => {
  const audio = createFakeAudioElement();
  const { engine } = makeEngine(audio);
  await engine.play();
  audio._simulateTimeUpdate(42);
  await engine.stop();
  assert.equal(audio.paused, true);
  assert.equal(audio.currentTime, 0);
});

test('seek sets the audio currentTime', async () => {
  const audio = createFakeAudioElement();
  const { engine } = makeEngine(audio);
  await engine.seek(30);
  assert.equal(audio.currentTime, 30);
});

test('getState reflects position, duration, and buffering', () => {
  const audio = createFakeAudioElement();
  const { engine } = makeEngine(audio);
  audio._simulateCanPlay(180);
  audio._simulateTimeUpdate(10);
  assert.deepEqual(engine.getState(), { position: 10, duration: 180, buffering: false });
  audio._simulateWaiting();
  assert.equal(engine.getState().buffering, true);
});

test('progress handler fires on timeupdate with position and duration', () => {
  const audio = createFakeAudioElement();
  const { engine } = makeEngine(audio);
  const events = [];
  engine.on('progress', (payload) => events.push(payload));
  audio._simulateCanPlay(200);
  audio._simulateTimeUpdate(15);
  assert.deepEqual(events, [{ position: 15, duration: 200 }]);
});

test('ended handler fires on the native ended event', () => {
  const audio = createFakeAudioElement();
  const { engine } = makeEngine(audio);
  let called = false;
  engine.on('ended', () => { called = true; });
  audio._simulateEnded();
  assert.equal(called, true);
});

test('error handler fires with a mapped Error on the native error event', () => {
  const audio = createFakeAudioElement();
  const { engine } = makeEngine(audio);
  const errors = [];
  engine.on('error', (err) => errors.push(err));
  audio._simulateError(2);
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /MEDIA_ERR_NETWORK/);
});

test('getAudioGraphAnchor returns the media element source node connected to the context destination', () => {
  const audio = createFakeAudioElement();
  const audioContext = createFakeAudioContext();
  const { engine } = makeEngine(audio, audioContext);
  const anchor = engine.getAudioGraphAnchor();
  assert.equal(anchor.audioElement, audio);
  assert.equal(anchor.connectedTo, audioContext.destination);
});

test('a media error during load() does not also fire the persistent error handler', async () => {
  const audio = createFakeAudioElement();
  const { engine } = makeEngine(audio);
  const errors = [];
  engine.on('error', (err) => errors.push(err));
  const loadPromise = engine.load({ url: 'file:///broken.mp3' });
  audio._simulateError(4);
  await assert.rejects(() => loadPromise);
  assert.equal(errors.length, 0);
});

test('a media error outside of a load still fires the persistent error handler', () => {
  const audio = createFakeAudioElement();
  const { engine } = makeEngine(audio);
  const errors = [];
  engine.on('error', (err) => errors.push(err));
  audio._simulateError(2);
  assert.equal(errors.length, 1);
});

test('load() does not leak canplay/error listeners across repeated calls', async () => {
  const audio = createFakeAudioElement();
  const { engine } = makeEngine(audio);
  for (let i = 0; i < 5; i += 1) {
    const loadPromise = engine.load({ url: `file:///track-${i}.mp3` });
    audio._simulateCanPlay(100);
    await loadPromise;
  }
  assert.equal(getEventListeners(audio, 'canplay').length, 0);
  assert.equal(getEventListeners(audio, 'error').length, 0);
});

test('play resumes a suspended audio context before playing', async () => {
  const audio = createFakeAudioElement();
  const audioContext = createFakeAudioContext();
  audioContext.state = 'suspended';
  let resumeCalled = false;
  const originalResume = audioContext.resume.bind(audioContext);
  audioContext.resume = async () => {
    resumeCalled = true;
    await originalResume();
  };
  const { engine } = makeEngine(audio, audioContext);
  await engine.play();
  assert.equal(resumeCalled, true);
  assert.equal(audioContext.state, 'running');
  assert.equal(audio.paused, false);
});
