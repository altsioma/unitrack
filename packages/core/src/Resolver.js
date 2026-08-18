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
      if (!(await provider.canResolve(ref))) {
        failedSources.push({ pluginId: ref.pluginId, sourceId: ref.sourceId, reason: 'provider cannot resolve this source' });
        continue;
      }
      try {
        return await provider.resolve(ref);
      } catch (err) {
        const originalReason = err instanceof Error ? err.message : String(err);
        // A provider whose capabilities advertise requiresRevalidation gets
        // one retry via revalidate() before this source counts as failed —
        // covers cases like an expired signed URL or a moved file, where a
        // freshly-revalidated ref might succeed where the first attempt
        // didn't.
        if (provider.capabilities?.requiresRevalidation) {
          const revalidation = await provider.revalidate(ref).catch(() =>
            /** @type {import('./types.js').RevalidationResult} */ ({ valid: false })
          );
          if (revalidation.valid && revalidation.ref) {
            try {
              return await provider.resolve(revalidation.ref);
            } catch (retryErr) {
              failedSources.push({
                pluginId: ref.pluginId,
                sourceId: ref.sourceId,
                reason: retryErr instanceof Error ? retryErr.message : String(retryErr),
              });
              continue;
            }
          }
          failedSources.push({
            pluginId: ref.pluginId,
            sourceId: ref.sourceId,
            reason: originalReason || revalidation.reason || 'resolution failed',
          });
          continue;
        }
        failedSources.push({ pluginId: ref.pluginId, sourceId: ref.sourceId, reason: originalReason });
      }
    }
  }

  throw new TrackResolutionError(track.id, failedSources);
}
