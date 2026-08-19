import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertSourceProviderConformance } from '@unitrack/conformance-kit';
import { createLocalFileSourceProvider } from '../src/index.js';

test('createLocalFileSourceProvider() satisfies the SourceProvider contract', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'unitrack-source-local-fs-conformance-'));
  try {
    const filePath = join(dir, 'song.flac');
    await writeFile(filePath, 'not real audio, just bytes');
    const provider = createLocalFileSourceProvider();
    const sampleRef = { pluginId: 'local-fs', token: { pluginId: 'local-fs', token: filePath }, kind: 'local' };
    await assertSourceProviderConformance(provider, sampleRef);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
