/**
 * @param {string} id
 * @param {import('../../src/types.js').SourceRef[]} [sources]
 * @returns {import('../../src/types.js').LogicalTrack}
 */
export function makeTrack(id, sources = []) {
  return { id, metadata: { artist: 'Artist', album: 'Album', title: id }, sources };
}
