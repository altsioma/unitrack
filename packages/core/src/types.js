/**
 * @typedef {Object} SourceRef
 * @property {string} pluginId
 * @property {string} sourceId
 * @property {string} kind
 * @property {string} [displayName]
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
 * @typedef {Object} PluginContext
 * @property {(scope: string, message: string, detail?: unknown) => void} log
 * @property {Record<string, unknown>} config
 * @property {{ platform: 'electron'|'web'|'ios'|'android', version: string }} host
 */

/**
 * @typedef {Object} RevalidationResult
 * @property {boolean} valid
 * @property {SourceRef} [ref]
 * @property {string} [reason]
 */

/**
 * @typedef {Object} SourceProviderCapabilities
 * @property {boolean} offline
 * @property {boolean} requiresRevalidation
 */

/**
 * @typedef {Object} SourceProvider
 * @property {string} id
 * @property {string} kind
 * @property {SourceProviderCapabilities} capabilities
 * @property {(ctx: PluginContext) => Promise<void>} initialize
 * @property {(ref: SourceRef) => Promise<boolean>} canResolve
 * @property {(ref: SourceRef) => Promise<ResolvedSource>} resolve
 * @property {(ref: SourceRef) => Promise<RevalidationResult>} revalidate
 * @property {() => Promise<void>} dispose
 */

/**
 * @typedef {Object} EngineState
 * @property {number} position
 * @property {number} duration
 * @property {boolean} buffering
 */

/**
 * @typedef {Object} PlaybackPlanEntry
 * @property {string} queueItemId
 * @property {ResolvedSource} resolved
 */

/**
 * @typedef {Object} PlaybackEngineCapabilities
 * @property {boolean} gapless
 * @property {boolean} backgroundPlayback
 * @property {'core'|'engine'} queueAuthority
 */

/**
 * @typedef {Object} PlaybackEngine
 * @property {string} id
 * @property {PlaybackEngineCapabilities} capabilities
 * @property {(ctx: PluginContext) => Promise<void>} initialize
 * @property {(resolved: ResolvedSource) => Promise<boolean>} canPlay
 * @property {(resolved: ResolvedSource) => Promise<void>} load
 * @property {() => Promise<void>} play
 * @property {() => Promise<void>} pause
 * @property {() => Promise<void>} stop
 * @property {(seconds: number) => Promise<void>} seek
 * @property {() => EngineState} getState
 * @property {(event: 'ended'|'error'|'progress'|'trackChanged', handler: (payload?: any) => void) => void} on
 * @property {(volume: number) => void} setVolume
 * @property {() => number} getVolume
 * @property {() => Promise<void>} dispose
 * @property {() => any} [getAudioGraphAnchor]
 * @property {(plan: PlaybackPlanEntry[]) => Promise<void>} [setPlaybackPlan] - required when capabilities.queueAuthority === 'engine'
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
 * @property {(ctx: PluginContext) => Promise<void>} initialize
 * @property {(query: MetadataQuery) => Promise<TrackMetadata[]>} search
 * @property {(ref: SourceRef) => Promise<TrackMetadata>} [fetchForSource]
 * @property {() => Promise<void>} dispose
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
 * @property {(ctx: PluginContext) => Promise<void>} initialize
 * @property {(playlistRef: PlaylistRef) => Promise<LogicalTrack[]>} fetchPlaylist
 * @property {() => Promise<PlaylistSummary[]>} [listPlaylists]
 * @property {() => Promise<void>} dispose
 */

/**
 * @typedef {'off' | 'all' | 'one'} RepeatMode
 */

/**
 * @typedef {'idle' | 'loading' | 'playing' | 'paused' | 'error'} PlayerStatus
 */

/**
 * @typedef {Object} CoreState
 * @property {PlayerStatus} status
 * @property {QueueItem | undefined} currentQueueItem
 * @property {number} position
 * @property {number} duration
 * @property {QueueItem[]} queue
 * @property {SourcePolicyRule[]} policy
 * @property {boolean} shuffle
 * @property {RepeatMode} repeatMode
 * @property {number} volume
 */

export {};
