import { CONTRACT_VERSION } from '../../src/types.js';

/**
 * @param {{
 *   id: string,
 *   kind: string,
 *   resolveImpl: (ref: import('../../src/types.js').SourceRef) => Promise<import('../../src/types.js').ResolvedSource>,
 *   canResolveImpl?: (ref: import('../../src/types.js').SourceRef) => boolean,
 *   capabilities?: import('../../src/types.js').SourceProviderCapabilities,
 *   revalidateImpl?: (token: import('../../src/types.js').SourceToken) => Promise<import('../../src/types.js').RevalidationResult>,
 * }} config
 * @returns {import('../../src/types.js').SourceProvider}
 */
export function createMockSourceProvider({
  id, kind, resolveImpl, canResolveImpl,
  capabilities = { offline: true, requiresRevalidation: false },
  revalidateImpl,
}) {
  return {
    id,
    kind,
    contractVersion: CONTRACT_VERSION,
    capabilities,
    async initialize(ctx) {},
    async dispose() {},
    async canResolve(ref) {
      return (canResolveImpl ?? (() => true))(ref);
    },
    resolve: resolveImpl,
    async revalidate(token) {
      if (revalidateImpl) return revalidateImpl(token);
      return { valid: false, reason: 'mock provider does not support revalidation' };
    },
  };
}

/**
 * @param {{
 *   id?: string,
 *   canPlayImpl?: (resolved: import('../../src/types.js').ResolvedSource) => boolean,
 *   capabilities?: import('../../src/types.js').PlaybackEngineCapabilities,
 *   planImpl?: (plan: import('../../src/types.js').PlaybackPlanEntry[]) => Promise<void>,
 * }} [config]
 * @returns {import('../../src/types.js').PlaybackEngine & { loaded: any, playCalls: number, pauseCalls: number, stopCalls: number, seekCalls: number[], volume: number, volumeCalls: number[], plan: import('../../src/types.js').PlaybackPlanEntry[] | null, _simulate: (event: string, payload?: any) => void, _listenerCount: (event: string) => number }}
 */
export function createMockPlaybackEngine({
  id, canPlayImpl,
  capabilities = { gapless: false, backgroundPlayback: false, queueAuthority: 'core' },
  planImpl,
} = {}) {
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map();
  const engine = {
    id: id ?? 'mock-engine',
    contractVersion: CONTRACT_VERSION,
    capabilities,
    async initialize(ctx) {},
    async dispose() {},
    async canPlay(resolved) {
      return (canPlayImpl ?? (() => true))(resolved);
    },
    loaded: null,
    playCalls: 0,
    pauseCalls: 0,
    stopCalls: 0,
    seekCalls: [],
    volume: 1,
    volumeCalls: [],
    plan: null,
    async load(resolved) { this.loaded = resolved; },
    async play() { this.playCalls += 1; },
    async pause() { this.pauseCalls += 1; },
    async stop() { this.stopCalls += 1; },
    async seek(seconds) { this.seekCalls.push(seconds); },
    setVolume(volume) { this.volume = volume; this.volumeCalls.push(volume); },
    getVolume() { return this.volume; },
    getState() { return { position: 0, duration: 0, buffering: false }; },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
    },
    off(event, handler) {
      listeners.get(event)?.delete(handler);
    },
    _simulate(event, payload) {
      for (const handler of listeners.get(event) ?? []) handler(payload);
    },
    _listenerCount(event) {
      return listeners.get(event)?.size ?? 0;
    },
  };
  if (capabilities.queueAuthority === 'engine') {
    engine.setPlaybackPlan = async (plan) => {
      engine.plan = plan;
      if (planImpl) await planImpl(plan);
    };
  }
  return engine;
}
