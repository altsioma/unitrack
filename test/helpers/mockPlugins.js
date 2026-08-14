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
