import { parseFile } from 'music-metadata';
import { titleFromFilename } from '@unitrack/util-fs';
import { CONTRACT_VERSION } from '@unitrack/core/types';

/**
 * @param {{ id?: string }} [config]
 * @returns {import('@unitrack/core/types').MetadataProvider}
 */
export function createLocalFileMetadataProvider({ id = 'metadata-local-fs' } = {}) {
  return {
    id,
    contractVersion: CONTRACT_VERSION,

    /**
     * @param {import('@unitrack/core/types').PluginContext} ctx
     * @returns {Promise<void>}
     */
    async initialize(ctx) {},

    /** @returns {Promise<void>} */
    async dispose() {},

    /**
     * @param {import('@unitrack/core/types').MetadataQuery} query
     * @returns {Promise<import('@unitrack/core/types').TrackMetadata[]>}
     */
    async search(query) {
      throw new Error(
        'search() is not supported by @unitrack/metadata-local-fs — this ' +
        'provider only reads tags from an already-known local file via ' +
        'fetchForSource(); use an online metadata provider for search-by-text.'
      );
    },
    /**
     * @param {import('@unitrack/core/types').SourceRef} ref
     * @returns {Promise<import('@unitrack/core/types').TrackMetadata>}
     */
    async fetchForSource(ref) {
      const path = ref.token.token;
      const parsed = await parseFile(path, { duration: true });
      const { common, format } = parsed;

      /** @type {import('@unitrack/core/types').TrackMetadata} */
      const metadata = {
        artist: common.artist ?? '',
        album: common.album ?? '',
        title: common.title ?? titleFromFilename(path),
      };
      if (format.duration !== undefined) {
        metadata.duration = format.duration;
      }
      const picture = common.picture?.[0];
      if (picture) {
        // picture.data is a plain Uint8Array, not a Node Buffer — calling
        // .toString('base64') directly on it silently ignores the encoding
        // argument and returns a comma-joined decimal dump instead (an
        // actual bug caught by this package's own cover-art test, which
        // decodes the resulting data: URL and checks the JPEG SOI marker
        // rather than just the string's shape). Buffer.from(...) wraps it
        // without copying semantics changing (Buffer is a Uint8Array
        // subclass) and gives a real base64 encoder.
        metadata.coverArtUrl = `data:${picture.format};base64,${Buffer.from(picture.data).toString('base64')}`;
      }
      return metadata;
    },
  };
}
