import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSourceProviderConformance,
  assertPlaybackEngineConformance,
  assertMetadataProviderConformance,
  assertPlaylistProviderConformance,
} from '../src/index.js';
import { CONTRACT_VERSION } from '@unitrack/core/types';
// Reused directly from @unitrack/core's own test helpers, per the design
// spec's Testing Decision 2: this kit's own suite proves the assertion
// functions actually fail against deliberately-broken input, not just
// pass against well-behaved input — starting from the exact same
// conformant mocks @unitrack/core's own test suite already trusts.
import { createMockSourceProvider, createMockPlaybackEngine } from '../../../core/test/helpers/mockPlugins.js';

const sampleRef = { pluginId: 'local-fs', token: { pluginId: 'local-fs', token: 'l1' }, kind: 'local' };
const sampleResolved = { kind: 'url', url: 'file:///a.flac', mime: 'audio/flac' };

// --- SourceProvider: conformant mock passes ---

test('assertSourceProviderConformance passes for a well-behaved mock SourceProvider', async () => {
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => sampleResolved,
    revalidateImpl: async (token) => ({ valid: true, token }),
  });
  await assert.doesNotReject(() => assertSourceProviderConformance(provider, sampleRef));
});

// --- SourceProvider: deliberately-broken mocks fail ---

test('assertSourceProviderConformance throws for a contractVersion mismatch', async () => {
  const provider = createMockSourceProvider({ id: 'local-fs', kind: 'local', resolveImpl: async () => sampleResolved });
  provider.contractVersion = '0.2.0';
  await assert.rejects(() => assertSourceProviderConformance(provider, sampleRef), /contractVersion/);
});

test('assertSourceProviderConformance throws for an unknown capability key', async () => {
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => sampleResolved,
    capabilities: { offline: true, requiresRevalidation: false, madeUp: true },
  });
  await assert.rejects(() => assertSourceProviderConformance(provider, sampleRef), /unknown key "madeUp"/);
});

test('assertSourceProviderConformance throws when resolve() returns a shape missing mime', async () => {
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => (/** @type {any} */ ({ kind: 'url', url: 'file:///a.flac' })),
  });
  await assert.rejects(() => assertSourceProviderConformance(provider, sampleRef), /mime must be a string/);
});

test('assertSourceProviderConformance throws when sampleRef.pluginId does not match sampleRef.token.pluginId', async () => {
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => sampleResolved,
  });
  const mismatchedRef = { pluginId: 'local-fs', token: { pluginId: 'not-local-fs', token: 'l1' }, kind: 'local' };
  await assert.rejects(
    () => assertSourceProviderConformance(provider, mismatchedRef),
    /sampleRef\.pluginId .* must match sampleRef\.token\.pluginId/
  );
});

test('assertSourceProviderConformance throws when revalidate() omits .valid', async () => {
  const provider = createMockSourceProvider({
    id: 'local-fs', kind: 'local',
    resolveImpl: async () => sampleResolved,
    revalidateImpl: async () => (/** @type {any} */ ({})),
  });
  await assert.rejects(() => assertSourceProviderConformance(provider, sampleRef), /\.valid must be a boolean/);
});

// --- PlaybackEngine: conformant mock passes ---

test('assertPlaybackEngineConformance passes for a well-behaved mock PlaybackEngine', async () => {
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  await assert.doesNotReject(() => assertPlaybackEngineConformance(engine, sampleResolved));
});

test('assertPlaybackEngineConformance passes for a lookaheadPlayback: true mock (setPlaybackPlan required and present)', async () => {
  const engine = createMockPlaybackEngine({
    id: 'audio-queue',
    capabilities: { gapless: true, backgroundPlayback: false, lookaheadPlayback: true },
  });
  await assert.doesNotReject(() => assertPlaybackEngineConformance(engine, sampleResolved));
});

// --- PlaybackEngine: deliberately-broken mocks fail ---

test('assertPlaybackEngineConformance throws for a contractVersion mismatch', async () => {
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  engine.contractVersion = '0.2.0';
  await assert.rejects(() => assertPlaybackEngineConformance(engine, sampleResolved), /contractVersion/);
});

test('assertPlaybackEngineConformance throws for an unknown capability key', async () => {
  const engine = createMockPlaybackEngine({
    id: 'web-audio',
    capabilities: { gapless: false, backgroundPlayback: false, lookaheadPlayback: false, madeUp: true },
  });
  await assert.rejects(() => assertPlaybackEngineConformance(engine, sampleResolved), /unknown key "madeUp"/);
});

test('assertPlaybackEngineConformance throws when lookaheadPlayback: true but setPlaybackPlan is missing', async () => {
  const engine = createMockPlaybackEngine({ id: 'audio-queue', capabilities: { gapless: true, backgroundPlayback: false, lookaheadPlayback: true } });
  delete (/** @type {any} */ (engine)).setPlaybackPlan;
  await assert.rejects(() => assertPlaybackEngineConformance(engine, sampleResolved), /setPlaybackPlan must be a function/);
});

test('assertPlaybackEngineConformance throws when off() is missing', async () => {
  const engine = createMockPlaybackEngine({ id: 'web-audio' });
  delete (/** @type {any} */ (engine)).off;
  await assert.rejects(() => assertPlaybackEngineConformance(engine, sampleResolved), /off must be a function/);
});

// --- MetadataProvider ---

test('assertMetadataProviderConformance passes for a minimal, well-behaved provider', async () => {
  const provider = {
    id: 'musicbrainz', contractVersion: CONTRACT_VERSION,
    async initialize() {}, async dispose() {},
    async search() { return []; },
  };
  await assert.doesNotReject(() => assertMetadataProviderConformance(provider));
});

test('assertMetadataProviderConformance throws when search is missing', async () => {
  const provider = /** @type {any} */ ({
    id: 'musicbrainz', contractVersion: CONTRACT_VERSION,
    async initialize() {}, async dispose() {},
  });
  await assert.rejects(() => assertMetadataProviderConformance(provider), /search must be a function/);
});

// --- PlaylistProvider ---

test('assertPlaylistProviderConformance passes for a minimal, well-behaved provider with no sample ref (shape-only check)', async () => {
  const provider = {
    id: 'local-playlists', contractVersion: CONTRACT_VERSION,
    async initialize() {}, async dispose() {},
    async fetchPlaylist() { return []; },
  };
  await assert.doesNotReject(() => assertPlaylistProviderConformance(provider));
});

test('assertPlaylistProviderConformance passes and validates LogicalTrack shape when a sample ref drives a real fetchPlaylist() call', async () => {
  const provider = {
    id: 'local-playlists', contractVersion: CONTRACT_VERSION,
    async initialize() {}, async dispose() {},
    async fetchPlaylist() {
      return [{ id: 't1', metadata: { artist: 'A', album: 'B', title: 'C' }, sources: [sampleRef] }];
    },
  };
  await assert.doesNotReject(() => assertPlaylistProviderConformance(provider, { pluginId: 'local-playlists', playlistId: '/music' }));
});

test('assertPlaylistProviderConformance throws when fetchPlaylist() returns a track with a malformed source token', async () => {
  const provider = {
    id: 'local-playlists', contractVersion: CONTRACT_VERSION,
    async initialize() {}, async dispose() {},
    async fetchPlaylist() {
      return [{
        id: 't1', metadata: { artist: 'A', album: 'B', title: 'C' },
        sources: [/** @type {any} */ ({ pluginId: 'local-fs', kind: 'local' })],
      }];
    },
  };
  await assert.rejects(
    () => assertPlaylistProviderConformance(provider, { pluginId: 'local-playlists', playlistId: '/music' }),
    /token must be an object/
  );
});

test('assertPlaylistProviderConformance throws for a contractVersion mismatch', async () => {
  const provider = {
    id: 'local-playlists', contractVersion: '0.2.0',
    async initialize() {}, async dispose() {},
    async fetchPlaylist() { return []; },
  };
  await assert.rejects(() => assertPlaylistProviderConformance(provider), /contractVersion/);
});
