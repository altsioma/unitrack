/**
 * @typedef {Object} SourceRef
 * @property {string} pluginId
 * @property {string} sourceId
 * @property {string} kind
 */

/**
 * @typedef {Object} LogicalTrack
 * @property {string} id
 * @property {{ artist: string, album: string, title: string, duration?: number }} metadata
 * @property {SourceRef[]} sources
 */

/**
 * @typedef {Object} QueueItem
 * @property {string} queueItemId
 * @property {LogicalTrack} track
 */

/**
 * @typedef {Object} ResolvedSource
 * @property {string} url
 * @property {string} [format]
 * @property {number} [bitrate]
 */

/**
 * @typedef {Object} SourcePolicyRule
 * @property {string} [kind]
 * @property {string} [pluginId]
 */

/**
 * @typedef {Object} SourceProvider
 * @property {string} id
 * @property {string} kind
 * @property {(ref: SourceRef) => boolean} canResolve
 * @property {(ref: SourceRef) => Promise<ResolvedSource>} resolve
 * @property {() => Promise<void>} [dispose]
 */

export {};
