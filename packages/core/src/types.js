// The current plugin contract version. Bumped whenever a breaking change
// lands in the shapes below — independent of any individual package's own
// npm version, which can (and, once packages/plugins/* exists, will) drift
// on its own. PluginRegistry checks every registered plugin's declared
// contractVersion against this at registration time (see
// PluginRegistry.js) — an exact match is required; see the v0.3.0 design
// spec's Implementation Decision 4 for why this isn't a semver range yet.
export const CONTRACT_VERSION = '0.4.0';

// The closed list of capability keys each plugin category is allowed to
// declare. PluginRegistry.registerX() rejects a plugin whose capabilities
// object has a key outside this list — catching a typo'd or
// contract-version-mismatched capability at registration instead of it
// silently being ignored everywhere that reads `capabilities.something`.
export const SOURCE_PROVIDER_CAPABILITY_KEYS = ['offline', 'requiresRevalidation'];
export const PLAYBACK_ENGINE_CAPABILITY_KEYS = ['gapless', 'backgroundPlayback', 'lookaheadPlayback', 'nowPlaying'];

/**
 * An opaque, self-describing handle a SourceProvider hands out for one of
 * a LogicalTrack's sources. `token` is meaningful only to the provider
 * that minted it — nothing else may parse, construct, or interpret it.
 * `pluginId` is deliberately redundant with the enclosing SourceRef's own
 * `pluginId` (see SourceRef) so a bare SourceToken — e.g. one read back
 * from a persisted CoreState snapshot before any provider has
 * (re-)registered — is still self-describing on its own.
 *
 * `token` is provider-owned, not necessarily secret — a local filesystem
 * provider may use a path as its token, where opacity is not secrecy. It is
 * still excluded from standard error payloads, user-facing events, and
 * default logging by every module that touches it (Resolver.js,
 * CorePlayer.js, the conformance kit, and any host diagnostics) — only the
 * provider that minted it may interpret it; everything else may persist and
 * pass it through but must not parse or display its raw value.
 * @typedef {Object} SourceToken
 * @property {string} pluginId
 * @property {string} token
 * @property {string} [displayPath] - human-readable, safe to show/persist/log even once the token itself no longer resolves; never used for resolution
 */

/**
 * `pluginId` and `token.pluginId` must be identical — a mismatch is invalid
 * input, rejected before resolving, revalidating, or persisting the ref
 * (see Resolver.js's resolveTrack()). The duplicated ID is useful when only
 * a token survives (e.g. a persisted CoreState snapshot read back before
 * any provider has registered); a genuine mismatch between the two is never
 * reconciled heuristically.
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
 * @property {Record<string, string>} [headers] - request headers a consumer must send when fetching `url`; credentials belong here, never embedded in the URL itself. Like SourceToken.token, headers are excluded from standard error payloads, user-facing events, and default logging — a diagnostic may include pluginId, kind, displayPath, a redacted URL origin, and a reason code, but never the raw headers object.
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
 * A revisioned, short-lived lookahead snapshot Core sends to a
 * lookaheadPlayback-capable engine via setPlaybackPlan(). It is disposable
 * derived state, not a second queue — Core remains the sole owner of the
 * canonical queue (see CorePlayer's queue commands). `revision` strictly
 * increases every time Core installs, replaces, or invalidates a plan; an
 * engine treats a later revision as superseding every earlier one — it
 * cancels outstanding preparation where possible, releases resources for
 * entries that never start, and never starts an uncommitted entry from an
 * older plan. Events for an obsolete revision (see PlaybackEngine's
 * 'playbackStarted'/'playbackExhausted') are ignored, not errors.
 * @typedef {Object} PlaybackPlan
 * @property {number} revision
 * @property {PlaybackPlanEntry[]} entries
 */

/**
 * @typedef {Object} PlaybackEngineCapabilities
 * @property {boolean} gapless
 * @property {boolean} backgroundPlayback
 * @property {boolean} lookaheadPlayback - whether this engine implements setPlaybackPlan() and reports 'playbackStarted'/'playbackExhausted' instead of relying on Core's plain load()+play() path. Describes pre-buffering ability, not queue ownership — Core always owns the canonical queue regardless of this flag.
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
 * Payload for both 'playbackStarted' and 'playbackExhausted' — see
 * PlaybackPlan's doc comment for the revision-acceptance rule Core applies
 * to both. 'playbackStarted' fires for every actual start, including the
 * initial play and a gapless hand-off. 'playbackExhausted' fires after the
 * last actually-started entry in the accepted plan ends without a prepared
 * successor.
 * @typedef {Object} PlaybackPlanEventPayload
 * @property {string} queueItemId
 * @property {number} planRevision
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
 * @property {(event: 'ended'|'error'|'progress'|'playbackStarted'|'playbackExhausted'|'transportCommand', handler: (payload?: any) => void) => void} on
 * @property {(event: 'ended'|'error'|'progress'|'playbackStarted'|'playbackExhausted'|'transportCommand', handler: (payload?: any) => void) => void} off
 * @property {(volume: number) => void} setVolume
 * @property {() => number} getVolume
 * @property {() => Promise<void>} dispose
 * @property {() => any} [getAudioGraphAnchor]
 * @property {(plan: PlaybackPlan) => Promise<void>} [setPlaybackPlan] - required when capabilities.lookaheadPlayback === true
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

/**
 * - 'providerMissing': no registered provider matches the SourceRef.
 * - 'available': a provider requiring revalidation returned a valid token.
 * - 'invalid': that provider returned `valid: false`.
 * - 'unchecked': a registered provider does not require revalidation, or
 *   its revalidation could not complete. Does not prove playback will fail.
 * @typedef {'available' | 'providerMissing' | 'invalid' | 'unchecked'} SourceAvailabilityStatus
 */

/**
 * @typedef {Object} SourceAvailabilityEntry
 * @property {string} pluginId
 * @property {string} [displayPath]
 * @property {SourceAvailabilityStatus} status
 * @property {string} [reason]
 */

/**
 * Result of CorePlayer.inspectSourceAvailability() — a host-requested,
 * non-mutating assessment. Never performs network/filesystem revalidation
 * unprompted, never resolves or plays media, and never carries a raw
 * SourceToken.token value.
 * @typedef {Object} SourceAvailabilityResult
 * @property {string} queueItemId
 * @property {SourceAvailabilityEntry[]} sources
 */
