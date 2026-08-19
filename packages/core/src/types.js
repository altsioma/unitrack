// The current plugin contract version. Bumped whenever a breaking change
// lands in the shapes below — independent of any individual package's own
// npm version, which can (and, once packages/plugins/* exists, will) drift
// on its own. PluginRegistry checks every registered plugin's declared
// contractVersion against this at registration time (see
// PluginRegistry.js) — an exact match is required; see the v0.3.0 design
// spec's Implementation Decision 4 for why this isn't a semver range yet.
export const CONTRACT_VERSION = '0.3.0';

// The closed list of capability keys each plugin category is allowed to
// declare. PluginRegistry.registerX() rejects a plugin whose capabilities
// object has a key outside this list — catching a typo'd or
// contract-version-mismatched capability at registration instead of it
// silently being ignored everywhere that reads `capabilities.something`.
export const SOURCE_PROVIDER_CAPABILITY_KEYS = ['offline', 'requiresRevalidation'];
export const PLAYBACK_ENGINE_CAPABILITY_KEYS = ['gapless', 'backgroundPlayback', 'queueAuthority', 'nowPlaying'];

/**
 * An opaque, self-describing handle a SourceProvider hands out for one of
 * a LogicalTrack's sources. `token` is meaningful only to the provider
 * that minted it — nothing else may parse, construct, or interpret it.
 * `pluginId` is deliberately redundant with the enclosing SourceRef's own
 * `pluginId` (see SourceRef) so a bare SourceToken — e.g. one read back
 * from a persisted CoreState snapshot before any provider has
 * (re-)registered — is still self-describing on its own.
 * @typedef {Object} SourceToken
 * @property {string} pluginId
 * @property {string} token
 * @property {string} [displayPath] - human-readable, safe to show/persist/log even once the token itself no longer resolves; never used for resolution
 */

/**
 * @typedef {Object} SourceRef
 * @property {string} pluginId
 * @property {SourceToken} token
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
 * A resolved, playable source. `kind` is a required, explicit
 * discriminant (rather than being inferred from which optional field is
 * present) so consumers narrow on it directly and so a 'url'-kind result
 * — every producer in this repo today — still documents its variant
 * rather than leaving readers to guess. `stream`/`buffer` have no
 * producer in this repo yet; they exist so a future non-URL source (a
 * File System Access API handle, an in-memory buffer from a mobile
 * media-library picker) has somewhere to put its result without another
 * breaking contract change.
 * @typedef {Object} ResolvedSource
 * @property {'url' | 'stream' | 'buffer'} kind
 * @property {string} [url] - present when kind === 'url'; may be file://, blob:, content://, ph://, or a plain http(s) URL
 * @property {ReadableStream} [stream] - present when kind === 'stream'
 * @property {ArrayBuffer} [buffer] - present when kind === 'buffer'
 * @property {string} mime
 * @property {Record<string, string>} [headers] - request headers a consumer must send when fetching `url`; credentials belong here, never embedded in the URL itself
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
 * @property {SourceToken} [token]
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
 * @property {string} contractVersion - must match CONTRACT_VERSION; checked by PluginRegistry.registerSourceProvider()
 * @property {SourceProviderCapabilities} capabilities
 * @property {(ctx: PluginContext) => Promise<void>} initialize
 * @property {(ref: SourceRef) => Promise<boolean>} canResolve
 * @property {(ref: SourceRef) => Promise<ResolvedSource>} resolve
 * @property {(token: SourceToken) => Promise<RevalidationResult>} revalidate
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
 * @property {boolean} [nowPlaying] - whether this engine implements setNowPlaying() and reports 'transportCommand'
 */

/**
 * Now-playing metadata a nowPlaying-capable engine surfaces to the
 * platform's system media UI (a lock screen, a notification, CarPlay,
 * Android Auto). Purely descriptive — setting it has no effect on
 * playback itself.
 * @typedef {Object} NowPlayingInfo
 * @property {string} title
 * @property {string} artist
 * @property {string} [album]
 * @property {number} [duration]
 * @property {string} [artworkUrl]
 */

/**
 * @typedef {Object} TransportCommandPayload
 * @property {'play' | 'pause' | 'next' | 'previous'} command
 */

/**
 * @typedef {Object} PlaybackEngine
 * @property {string} id
 * @property {string} contractVersion - must match CONTRACT_VERSION; checked by PluginRegistry.registerPlaybackEngine()
 * @property {PlaybackEngineCapabilities} capabilities
 * @property {(ctx: PluginContext) => Promise<void>} initialize
 * @property {(resolved: ResolvedSource) => Promise<boolean>} canPlay
 * @property {(resolved: ResolvedSource) => Promise<void>} load
 * @property {() => Promise<void>} play
 * @property {() => Promise<void>} pause
 * @property {() => Promise<void>} stop
 * @property {(seconds: number) => Promise<void>} seek
 * @property {() => EngineState} getState
 * @property {(event: 'ended'|'error'|'progress'|'trackChanged'|'transportCommand', handler: (payload?: any) => void) => void} on
 * @property {(event: 'ended'|'error'|'progress'|'trackChanged'|'transportCommand', handler: (payload?: any) => void) => void} off
 * @property {(volume: number) => void} setVolume
 * @property {() => number} getVolume
 * @property {() => Promise<void>} dispose
 * @property {() => any} [getAudioGraphAnchor]
 * @property {(plan: PlaybackPlanEntry[]) => Promise<void>} [setPlaybackPlan] - required when capabilities.queueAuthority === 'engine'
 * @property {(info: NowPlayingInfo) => Promise<void>} [setNowPlaying] - required when capabilities.nowPlaying === true
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
 * @property {string} contractVersion - must match CONTRACT_VERSION; checked by PluginRegistry.registerMetadataProvider()
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
 * @property {string} contractVersion - must match CONTRACT_VERSION; checked by PluginRegistry.registerPlaylistProvider()
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
