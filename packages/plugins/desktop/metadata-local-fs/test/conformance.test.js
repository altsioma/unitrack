import { test } from 'node:test';
import { assertMetadataProviderConformance } from '@unitrack/conformance-kit';
import { createLocalFileMetadataProvider } from '../src/index.js';

// No search()/fetchForSource() call here — the kit deliberately doesn't
// invoke either (see assertMetadataProviderConformance's doc comment):
// this provider's search() always throws by design (asserted separately
// in test/index.test.js), which a generic conformance check can't assume
// is true of every MetadataProvider.
test('createLocalFileMetadataProvider() satisfies the MetadataProvider contract', async () => {
  const provider = createLocalFileMetadataProvider();
  await assertMetadataProviderConformance(provider);
});
