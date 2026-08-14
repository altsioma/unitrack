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

/**
 * @typedef {Object} EngineState
 * @property {number} position
 * @property {number} duration
 * @property {boolean} buffering
 */

/**
 * @typedef {Object} PlaybackEngine
 * @property {string} id
 * @property {(resolved: ResolvedSource) => boolean} canPlay
 * @property {(resolved: ResolvedSource) => Promise<void>} load
 * @property {() => Promise<void>} play
 * @property {() => Promise<void>} pause
 * @property {() => Promise<void>} stop
 * @property {(seconds: number) => Promise<void>} seek
 * @property {() => EngineState} getState
 * @property {(event: 'ended'|'error'|'progress', handler: (payload?: any) => void) => void} on
 * @property {() => any} [getAudioGraphAnchor]
 */

/**
 * @typedef {Object} MetadataQuery
 * @property {string} [artist]
 * @property {string} [title]
 */

/**
 * @typedef {Object} TrackMetadata
 * @property {string} artist
 * @property {string} album
 * @property {string} title
 * @property {number} [duration]
 * @property {string} [coverArtUrl]
 */

/**
 * @typedef {Object} MetadataProvider
 * @property {string} id
 * @property {(query: MetadataQuery) => Promise<TrackMetadata[]>} search
 * @property {(ref: SourceRef) => Promise<TrackMetadata>} [fetchForSource]
 */

/**
 * @typedef {Object} PlaylistRef
 * @property {string} pluginId
 * @property {string} playlistId
 */

/**
 * @typedef {Object} PlaylistSummary
 * @property {string} playlistId
 * @property {string} name
 */

/**
 * @typedef {Object} PlaylistProvider
 * @property {string} id
 * @property {(playlistRef: PlaylistRef) => Promise<LogicalTrack[]>} fetchPlaylist
 * @property {() => Promise<PlaylistSummary[]>} [listPlaylists]
 */

export {};
