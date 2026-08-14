import { access, constants } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { extname } from 'node:path';

/** @returns {import('@unitrack/core/types').SourceProvider} */
export function createLocalFileSourceProvider() {
  return {
    id: 'local-fs',
    kind: 'local',
    /**
     * @param {import('@unitrack/core/types').SourceRef} ref
     * @returns {boolean}
     */
    canResolve(ref) {
      return ref.pluginId === 'local-fs';
    },
    /**
     * @param {import('@unitrack/core/types').SourceRef} ref
     * @returns {Promise<import('@unitrack/core/types').ResolvedSource>}
     */
    async resolve(ref) {
      await access(ref.sourceId, constants.R_OK);
      const url = pathToFileURL(ref.sourceId).href;
      const ext = extname(ref.sourceId).slice(1).toLowerCase();
      const resolved = /** @type {import('@unitrack/core/types').ResolvedSource} */ ({ url });
      if (ext) resolved.format = ext;
      return resolved;
    },
  };
}
