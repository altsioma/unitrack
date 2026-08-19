// A deliberately real-TypeScript file — every other package in this repo
// is plain JS + JSDoc, type-checked via `tsc --checkJs` against its own
// source. That proves the JSDoc annotations are internally consistent, but
// not that the *published* `.d.ts` output (packages/core/dist/types.d.ts,
// built from types.js's JSDoc via tsconfig.build.json) actually resolves
// and type-checks the way a genuine `.ts` consumer — an app built with
// real TypeScript, not JSDoc — would experience it. This package exists
// purely to close that gap: import a few representative types from
// @unitrack/core/types, construct a minimal SourceProvider-shaped object
// against them, and let `tsc --noEmit` be the actual proof.
//
// No runtime output is produced and this package is never published — see
// package.json's `private: true` and its lack of a `build:types`/`test`
// script.

import { CONTRACT_VERSION } from '@unitrack/core/types';
import type { SourceProvider, SourceRef, ResolvedSource } from '@unitrack/core/types';

const contractVersion: string = CONTRACT_VERSION;

const sampleRef: SourceRef = {
  pluginId: 'fixture',
  token: { pluginId: 'fixture', token: 'x' },
  kind: 'local',
};

const provider: SourceProvider = {
  id: 'fixture',
  kind: 'local',
  contractVersion,
  capabilities: { offline: true, requiresRevalidation: false },
  async initialize() {},
  async canResolve(ref) {
    return ref.pluginId === 'fixture';
  },
  async resolve(ref): Promise<ResolvedSource> {
    return { kind: 'url', url: `file:///${ref.token.token}`, mime: 'audio/flac' };
  },
  async revalidate(token) {
    return { valid: true, token };
  },
  async dispose() {},
};

export { contractVersion, sampleRef, provider };
