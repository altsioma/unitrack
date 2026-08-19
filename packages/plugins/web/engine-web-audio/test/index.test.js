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

test('canPlay returns true for a mime type the browser reports as playable', async () => {
  const audio = createFakeAudioElement();
  audio._canPlayTypeResult = 'probably';
  const { engine } = makeEngine(audio);
  assert.equal(await engine.canPlay({ kind: 'url', url: 'file:///a.mp3', mime: 'audio/mpeg' }), true);
});

test('canPlay returns false for a mime type the browser cannot play', async () => {
  const audio = createFakeAudioElement();
  audio._canPlayTypeResult = '';
  const { engine } = makeEngine(audio);
  assert.equal(await engine.canPlay({ kind: 'url', url: 'file:///a.mp3', mime: 'audio/mpeg' }), false);
});

test('canPlay returns true when no mime is present at all', async () => {
  const { engine } = makeEngine();
  assert.equal(await engine.canPlay({ kind: 'url', url: 'file:///a', mime: '' }), true);
});

test('canPlay returns false for a non-url kind — this engine only supports kind: "url"', async () => {
  const { engine } = makeEngine();
  assert.equal(await engine.canPlay({ kind: 'buffer', buffer: new ArrayBuffer(0), mime: 'audio/mpeg' }), false);
});

test('exposes core-owned, non-gapless, no-background-playback capabilities', () => {
  const { engine } = makeEngine();
  assert.deepEqual(engine.capabilities, { gapless: false, backgroundPlayback: false, queueAuthority: 'core' });
});

test('initialize resolves without throwing', async () => {
  const { engine } = makeEngine();
  await engine.initialize({});
});

test('dispose closes the AudioContext', async () => {
  const { engine, audioContext } = makeEngine();
  await engine.dispose();
  assert.equal(audioContext.state, 'closed');
});

test('dispose is a no-op when the AudioContext is already closed', async () => {
  const { engine, audioContext } = makeEngine();
  await engine.dispose();
  await engine.dispose();
  assert.equal(audioContext.state, 'closed');
});

test('load sets the audio src and resolves once canplay fires', async () => {
  const audio = createFakeAudioElement();
  const { engine } = makeEngine(audio);
  const loadPromise = engine.load({ kind: 'url', url: 'file:///song.flac', mime: 'audio/flac' });
  assert.equal(audio.src, 'file:///song.flac');
  audio._simulateCanPlay(120);
  await loadPromise;
});

test('load rejects with a mapped error message when the element errors', async () => {
  const audio = createFakeAudioElement();
  const { engine } = makeEngine(audio);
  const loadPromise = engine.load({ kind: 'url', url: 'file:///broken.mp3', mime: 'audio/mpeg' });
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

test('getAudioGraphAnchor returns the media element source node, routed to the destination through the volume GainNode', () => {
  const audio = createFakeAudioElement();
  const audioContext = createFakeAudioContext();
  const { engine } = makeEngine(audio, audioContext);
  const anchor = engine.getAudioGraphAnchor();
  assert.equal(anchor.audioElement, audio);
  // Volume (see the GainNode tests below) inserts a node between the
  // source and the destination, so the source no longer connects to the
  // destination directly — it connects to the GainNode, which connects
  // to the destination.
  const gainNode = audioContext._gainNodes[0];
  assert.equal(anchor.connectedTo, gainNode);
  assert.equal(gainNode.connectedTo, audioContext.destination);
});

test('a media error during load() does not also fire the persistent error handler', async () => {
  const audio = createFakeAudioElement();
  const { engine } = makeEngine(audio);
  const errors = [];
  engine.on('error', (err) => errors.push(err));
  const loadPromise = engine.load({ kind: 'url', url: 'file:///broken.mp3', mime: 'audio/mpeg' });
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
    const loadPromise = engine.load({ kind: 'url', url: `file:///track-${i}.mp3`, mime: 'audio/mpeg' });
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

test('getVolume defaults to 1 before any setVolume call', () => {
  const { engine } = makeEngine();
  assert.equal(engine.getVolume(), 1);
});

test('setVolume then getVolume round-trips, and updates the GainNode wired into the graph', () => {
  const { engine, audioContext } = makeEngine();
  engine.setVolume(0.5);
  assert.equal(engine.getVolume(), 0.5);
  assert.equal(audioContext._gainNodes[0].gain.value, 0.5);
});

test('setVolume clamps values above 1 to 1 and below 0 to 0', () => {
  const { engine } = makeEngine();
  engine.setVolume(1.5);
  assert.equal(engine.getVolume(), 1);
  engine.setVolume(-0.3);
  assert.equal(engine.getVolume(), 0);
});

test('setVolume(NaN) is a no-op — GainNode keeps its previous value', () => {
  const { engine, audioContext } = makeEngine();
  engine.setVolume(0.6);
  engine.setVolume(NaN);
  assert.equal(engine.getVolume(), 0.6);
  assert.equal(audioContext._gainNodes[0].gain.value, 0.6);
});

test('off() removes a progress listener so further timeupdate events no longer reach it', () => {
  const audio = createFakeAudioElement();
  const { engine } = makeEngine(audio);
  const events = [];
  const handler = (payload) => events.push(payload);
  engine.on('progress', handler);
  audio._simulateCanPlay(200);
  audio._simulateTimeUpdate(15);
  engine.off('progress', handler);
  audio._simulateTimeUpdate(30);
  assert.deepEqual(events, [{ position: 15, duration: 200 }]);
});

test('off() removes an ended listener', () => {
  const audio = createFakeAudioElement();
  const { engine } = makeEngine(audio);
  let calls = 0;
  const handler = () => { calls += 1; };
  engine.on('ended', handler);
  audio._simulateEnded();
  engine.off('ended', handler);
  audio._simulateEnded();
  assert.equal(calls, 1);
});

test('off() removes an error listener', () => {
  const audio = createFakeAudioElement();
  const { engine } = makeEngine(audio);
  const errors = [];
  const handler = (err) => errors.push(err);
  engine.on('error', handler);
  audio._simulateError(2);
  engine.off('error', handler);
  audio._simulateError(2);
  assert.equal(errors.length, 1);
});

test('off() is a no-op for a handler that was never registered, or for trackChanged/transportCommand (never attached by this engine)', () => {
  const audio = createFakeAudioElement();
  const { engine } = makeEngine(audio);
  assert.doesNotThrow(() => engine.off('progress', () => {}));
  assert.doesNotThrow(() => engine.off('trackChanged', () => {}));
  assert.doesNotThrow(() => engine.off('transportCommand', () => {}));
});

test('the GainNode is wired between the MediaElementAudioSourceNode and the AudioContext destination', () => {
  const { engine, audioContext } = makeEngine();
  const anchor = engine.getAudioGraphAnchor();
  const gainNode = audioContext._gainNodes[0];
  assert.equal(anchor.connectedTo, gainNode);
  assert.equal(gainNode.connectedTo, audioContext.destination);
});
