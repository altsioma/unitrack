import { readdir, stat } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';

const DEFAULT_EXTENSIONS = ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'];

/**
 * Depth-first walk of `dir`, sorted at every level so the result is
 * deterministic. Dotfiles/dot-directories and symlinks (files and
 * directories alike) are always skipped.
 *
 * @param {string} dir
 * @param {{ extensions: Set<string>, recursive: boolean }} config
 * @returns {Promise<string[]>}
 */
async function walk(dir, config) {
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));

  /** @type {string[]} */
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (config.recursive) {
        files.push(...(await walk(fullPath, config)));
      }
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = extname(entry.name).slice(1).toLowerCase();
    if (config.extensions.has(ext)) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * @param {string} filePath
 * @param {string} sourcePluginId
 * @returns {import('@unitrack/core/types').LogicalTrack}
 */
function toLogicalTrack(filePath, sourcePluginId) {
  const name = basename(filePath);
  const ext = extname(name);
  const title = ext ? name.slice(0, -ext.length) : name;
  return {
    id: filePath,
    metadata: { artist: '', album: '', title },
    sources: [{ pluginId: sourcePluginId, sourceId: filePath, kind: 'local' }],
  };
}

/**
 * @param {{
 *   id?: string,
 *   sourcePluginId?: string,
 *   extensions?: string[],
 *   recursive?: boolean,
 * }} [config]
 * @returns {import('@unitrack/core/types').PlaylistProvider}
 */
export function createLocalFolderPlaylistProvider({
  id = 'local-fs',
  sourcePluginId = 'local-fs',
  extensions = DEFAULT_EXTENSIONS,
  recursive = true,
} = {}) {
  const extensionSet = new Set(extensions.map((ext) => ext.toLowerCase()));
  return {
    id,
    /**
     * @param {import('@unitrack/core/types').PlaylistRef} playlistRef
     * @returns {Promise<import('@unitrack/core/types').LogicalTrack[]>}
     */
    async fetchPlaylist(playlistRef) {
      const { playlistId } = playlistRef;
      const stats = await stat(playlistId);
      if (!stats.isDirectory()) {
        throw new Error(`Not a directory: ${playlistId}`);
      }
      const files = await walk(playlistId, { extensions: extensionSet, recursive });
      return files.map((filePath) => toLogicalTrack(filePath, sourcePluginId));
    },
  };
}
