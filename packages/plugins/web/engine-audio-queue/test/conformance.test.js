import { test } from 'node:test';
import { assertPlaybackEngineConformance } from '@unitrack/conformance-kit';
import { createAudioQueuePlaybackEngine } from '../src/index.js';
import { createFakeAudioConstructor } from './helpers/domStubs.js';

test('createAudioQueuePlaybackEngine() satisfies the PlaybackEngine contract', async () => {
  const engine = createAudioQueuePlaybackEngine({ AudioConstructor: createFakeAudioConstructor() });
  await assertPlaybackEngineConformance(engine, { kind: 'url', url: 'file:///a.mp3', mime: 'audio/mpeg' });
});
