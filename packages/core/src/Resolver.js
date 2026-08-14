/**
 * @extends {Error}
 */
export class TrackResolutionError extends Error {
  /**
   * @param {string} trackId
   * @param {Array<{ pluginId: string, sourceId: string, reason: string }>} failedSources
   */
  constructor(trackId, failedSources) {
    super(`Failed to resolve track ${trackId}`);
    this.name = 'TrackResolutionError';
    this.trackId = trackId;
    this.failedSources = failedSources;
  }
}

/**
 * @param {import('./types.js').LogicalTrack} track
 * @param {import('./types.js').SourcePolicyRule[]} policy
 * @param {import('./types.js').SourceProvider[]} providers
 * @returns {Promise<import('./types.js').ResolvedSource>}
 */
export async function resolveTrack(track, policy, providers) {
  /** @type {Array<{ pluginId: string, sourceId: string, reason: string }>} */
  const failedSources = [];

  for (const rule of policy) {
    const matchingRefs = track.sources.filter((ref) =>
      (!rule.kind || ref.kind === rule.kind) &&
      (!rule.pluginId || ref.pluginId === rule.pluginId)
    );

    for (const ref of matchingRefs) {
      const provider = providers.find((p) => p.id === ref.pluginId);
      if (!provider) {
        failedSources.push({ pluginId: ref.pluginId, sourceId: ref.sourceId, reason: 'no provider registered for pluginId' });
        continue;
      }
      if (!provider.canResolve(ref)) {
        failedSources.push({ pluginId: ref.pluginId, sourceId: ref.sourceId, reason: 'provider cannot resolve this source' });
        continue;
      }
      try {
        return await provider.resolve(ref);
      } catch (err) {
        failedSources.push({
          pluginId: ref.pluginId,
          sourceId: ref.sourceId,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  throw new TrackResolutionError(track.id, failedSources);
}
