import { access, constants, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { extname } from 'node:path';

/**
 * @param {import('@unitrack/core/types').SourceRef} ref
 * @returns {Promise<import('@unitrack/core/types').ResolvedSource>}
 */
async function resolveRef(ref) {
  await access(ref.sourceId, constants.R_OK);
  const stats = await stat(ref.sourceId);
  if (!stats.isFile()) {
    throw new Error(`Not a regular file: ${ref.sourceId}`);
  }
  const url = pathToFileURL(ref.sourceId).href;
  const ext = extname(ref.sourceId).slice(1).toLowerCase();
  const resolved = /** @type {import('@unitrack/core/types').ResolvedSource} */ ({ url });
  if (ext) resolved.format = ext;
  return resolved;
}

/** @returns {import('@unitrack/core/types').SourceProvider} */
export function createLocalFileSourceProvider() {
  return {
    id: 'local-fs',
    kind: 'local',

    // Local files are readable without any network round-trip, and a path
    // on disk is stable enough that there is no separate "revalidate this
    // token" flow worth modelling — revalidate() below just re-attempts the
    // same filesystem check.
    capabilities: { offline: true, requiresRevalidation: false },

    /**
     * @param {import('@unitrack/core/types').PluginContext} ctx
     * @returns {Promise<void>}
     */
    async initialize(ctx) {},

    /** @returns {Promise<void>} */
    async dispose() {},

    /**
     * @param {import('@unitrack/core/types').SourceRef} ref
     * @returns {Promise<boolean>}
     */
    async canResolve(ref) {
      return ref.pluginId === 'local-fs';
    },
    /**
     * @param {import('@unitrack/core/types').SourceRef} ref
     * @returns {Promise<import('@unitrack/core/types').ResolvedSource>}
     */
    async resolve(ref) {
      return resolveRef(ref);
    },
    /**
     * @param {import('@unitrack/core/types').SourceRef} ref
     * @returns {Promise<import('@unitrack/core/types').RevalidationResult>}
     */
    async revalidate(ref) {
      try {
        await resolveRef(ref);
        return { valid: true, ref };
      } catch (err) {
        return { valid: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
