import { test } from 'node:test';
import { assertSourceProviderConformance } from '@unitrack/conformance-kit';
import { createSubsonicSourceProvider } from '../src/index.js';
import { startTestServer, pingHandler } from './helpers/testServer.js';

test('createSubsonicSourceProvider() satisfies the SourceProvider contract', async () => {
  const { baseUrl, close } = await startTestServer(pingHandler({ status: 'ok' }));
  try {
    const provider = createSubsonicSourceProvider({ baseUrl, username: 'alice', password: 'sesame' });
    const sampleRef = { pluginId: 'subsonic', token: { pluginId: 'subsonic', token: 'track-1' }, kind: 'self-hosted' };
    await assertSourceProviderConformance(provider, sampleRef);
  } finally {
    await close();
  }
});
