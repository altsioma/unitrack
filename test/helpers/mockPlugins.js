/**
 * @param {{ id: string, kind: string, resolveImpl: (ref: import('../../src/types.js').SourceRef) => Promise<import('../../src/types.js').ResolvedSource>, canResolveImpl?: (ref: import('../../src/types.js').SourceRef) => boolean }} config
 * @returns {import('../../src/types.js').SourceProvider}
 */
export function createMockSourceProvider({ id, kind, resolveImpl, canResolveImpl }) {
  return {
    id,
    kind,
    canResolve: canResolveImpl ?? (() => true),
    resolve: resolveImpl,
  };
}

/**
 * @param {{ id?: string, canPlayImpl?: (resolved: import('../../src/types.js').ResolvedSource) => boolean }} [config]
 * @returns {import('../../src/types.js').PlaybackEngine & { loaded: any, playCalls: number, pauseCalls: number, stopCalls: number, seekCalls: number[], _simulate: (event: string, payload?: any) => void }}
 */
export function createMockPlaybackEngine({ id, canPlayImpl } = {}) {
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map();
  return {
    id: id ?? 'mock-engine',
    canPlay: canPlayImpl ?? (() => true),
    loaded: null,
    playCalls: 0,
    pauseCalls: 0,
    stopCalls: 0,
    seekCalls: [],
    async load(resolved) { this.loaded = resolved; },
    async play() { this.playCalls += 1; },
    async pause() { this.pauseCalls += 1; },
    async stop() { this.stopCalls += 1; },
    async seek(seconds) { this.seekCalls.push(seconds); },
    getState() { return { position: 0, duration: 0, buffering: false }; },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
    },
    _simulate(event, payload) {
      for (const handler of listeners.get(event) ?? []) handler(payload);
    },
  };
}
