import { test } from 'node:test';
import { assertPlaybackEngineConformance } from '@unitrack/conformance-kit';
import { createWebAudioPlaybackEngine } from '../src/index.js';
import { createFakeAudioElement, createFakeAudioContext, asConstructor } from './helpers/domStubs.js';

test('createWebAudioPlaybackEngine() satisfies the PlaybackEngine contract', async () => {
  const engine = createWebAudioPlaybackEngine({
    AudioConstructor: asConstructor(createFakeAudioElement()),
    AudioContextConstructor: asConstructor(createFakeAudioContext()),
  });
  await assertPlaybackEngineConformance(engine, { kind: 'url', url: 'file:///a.mp3', mime: 'audio/mpeg' });
});
