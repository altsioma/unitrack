import { ipcRenderer } from 'electron';
import { CorePlayer } from '@unitrack/core';
import {
  createLocalFileSourceProvider,
  createSubsonicSourceProvider,
  createS3SourceProvider,
  createDirectUrlSourceProvider,
  createWebAudioPlaybackEngine,
  createLocalFolderPlaylistProvider,
} from './plugins.js';

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
function requireElement(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id} element`);
  return el;
}

/**
 * @param {string} id
 * @returns {HTMLInputElement}
 */
function requireInputElement(id) {
  const el = requireElement(id);
  if (!(el instanceof HTMLInputElement)) throw new Error(`#${id} is not an <input>`);
  return el;
}

/**
 * @param {string} id
 * @returns {HTMLSelectElement}
 */
function requireSelectElement(id) {
  const el = requireElement(id);
  if (!(el instanceof HTMLSelectElement)) throw new Error(`#${id} is not a <select>`);
  return el;
}

/**
 * @param {HTMLElement} parent
 * @param {{ label: string, disabled?: boolean, onClick: () => void }} config
 * @returns {void}
 */
function addButton(parent, { label, disabled = false, onClick }) {
  const button = document.createElement('button');
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener('click', onClick);
  parent.appendChild(button);
}

/**
 * @param {number} seconds
 * @returns {string}
 */
function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** @type {['off', 'all', 'one']} */
const REPEAT_CYCLE = ['off', 'all', 'one'];

/**
 * Runs `mapper` over `items` with at most `limit` calls in flight at once.
 * Unlike a bare Promise.all(items.map(mapper)), this bounds concurrency —
 * important for folder-open, where `items` can be hundreds of files and
 * each mapper call opens a file handle (via metadata parsing); running all
 * of them at once risks exhausting OS file-descriptor limits (EMFILE) on a
 * large library.
 * @template T
 * @template R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<R>} mapper
 * @returns {Promise<R[]>}
 */
async function mapWithConcurrencyLimit(items, limit, mapper) {
  /** @type {R[]} */
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]);
    }
  }
  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

const METADATA_FETCH_CONCURRENCY = 8;

// --- Logging -------------------------------------------------------------
//
// Verbose and unconditional, by design — see the design spec's "Logging"
// section. Everything goes to the main process over a *synchronous*
// channel: sendSync blocks the renderer until main has printed, so if the
// renderer dies the last line in the terminal is reliably the last step it
// actually reached. Plain console.log is mirrored too (main.js listens to
// 'console-message'), but asynchronously — it can lose exactly the final
// messages that matter during a crash.

/**
 * @param {string} scope
 * @param {string} message
 * @param {unknown} [detail]
 * @returns {void}
 */
function log(scope, message, detail) {
  try {
    ipcRenderer.sendSync('renderer-log', { scope, message, detail });
  } catch {
    // Diagnostics must never be the thing that breaks the app.
  }
}

// positionChanged fires several times a second; logging every one would
// bury everything else. Logged at a slow heartbeat instead, which is
// enough to show that playback is progressing and where it stalled.
const POSITION_LOG_INTERVAL_MS = 5000;

/**
 * Serializes CorePlayer state for logging — the full state object contains
 * the entire queue, which is far too noisy to print on every change.
 * @param {import('@unitrack/core/types').CoreState} state
 * @returns {object}
 */
function summarizeState(state) {
  return {
    status: state.status,
    track: state.currentQueueItem?.track.metadata.title ?? null,
    queueLength: state.queue.length,
    position: Math.round(state.position),
    duration: Math.round(state.duration),
    volume: state.volume,
    shuffle: state.shuffle,
    repeatMode: state.repeatMode,
  };
}

window.addEventListener('DOMContentLoaded', async () => {
  log('renderer', 'preload start', {
    node: process.versions.node,
    electron: process.versions.electron,
  });

  // Read once from the main process, which owns config.json. Falls back to
  // the same default main uses, so a failed IPC read can't silently flip
  // behaviour to the opposite of what the config says.
  /** @type {{ autoPlayOnOpen: boolean }} */
  const config = ipcRenderer.sendSync('get-config') ?? { autoPlayOnOpen: false };
  log('renderer', 'config', config);
  const core = new CorePlayer();
  core.registerSourceProvider(createLocalFileSourceProvider());
  // Unlike Subsonic/S3, this provider takes no config at all — the
  // SourceRef.token.token a caller supplies already is the complete URL —
  // so there's no connection form for it; it's simply always available,
  // same as @unitrack/web-demo/main.js registers it.
  core.registerSourceProvider(createDirectUrlSourceProvider());
  core.registerPlaybackEngine(createWebAudioPlaybackEngine());

  // A single catch-all policy rule (no kind/pluginId filter) matches every
  // SourceRef on a track in the order LogicalTrack.sources lists them.
  // Open File/Open Folder's sources are all kind 'local' and still match a
  // catch-all rule fine (there's exactly one source per locally-opened
  // track, so ordering is moot there); the Add Track form below produces
  // 'self-hosted'/'object-storage'/'direct-url'-kind sources whose
  // primary/fallback ordering only becomes meaningful under a catch-all
  // policy — the previous `[{ kind: 'local' }]` policy would have silently
  // dropped every source the new form can produce. See design spec's
  // "Policy change" section and @unitrack/web-demo/main.js, which solves
  // the identical problem the same way.
  core.setPolicy([{}]);
  log('renderer', 'core constructed; source-local-fs + source-direct-url + engine-web-audio registered');

  /**
   * core.initializePlugins() must run before the first play() (v0.2.0
   * contract — see PluginsNotInitializedError), and is safe to call again
   * after a new provider registers: every SourceProvider/PlaybackEngine's
   * own initialize() in this app's plugin set is either a no-op or
   * idempotent, and CorePlayer.initializePlugins() itself just re-runs
   * initialize() on every currently-registered plugin with no state that
   * would make a second call unsafe.
   * @returns {Promise<void>}
   */
  async function reinitializePlugins() {
    await core.initializePlugins({
      log: (scope, message, detail) => log(`core:${scope}`, message, detail),
      config: {},
      host: { platform: 'electron', version: process.versions.electron },
    });
  }

  await reinitializePlugins();
  log('renderer', 'core.initializePlugins complete');

  // The playlist provider stays in the renderer (plain node:fs, no dynamic
  // import, verified working). Tag reading does not — see main.js's
  // 'fetch-metadata' handler for why it has to run in the main process.
  const playlistProvider = createLocalFolderPlaylistProvider();

  const statusEl = requireElement('status');
  const queueListEl = requireElement('queue-list');
  const seekEl = requireInputElement('seek');
  const timeEl = requireElement('time');
  const volumeEl = requireInputElement('volume');
  const shuffleEl = requireElement('shuffle');
  const repeatEl = requireElement('repeat');

  /** @type {string | undefined} */
  let lastErrorText;
  let scrubbing = false;

  /** @returns {void} */
  function updateStatus() {
    const state = core.getState();
    if (state.status === 'error' && lastErrorText) {
      statusEl.textContent = `error: ${lastErrorText}`;
      return;
    }
    const title = state.currentQueueItem?.track.metadata.title ?? '(no track)';
    statusEl.textContent = `${state.status} — ${title}`;
  }

  /** @returns {void} */
  function renderQueue() {
    const state = core.getState();
    const items = state.queue;
    const currentIndex = state.currentQueueItem
      ? items.findIndex((item) => item.queueItemId === state.currentQueueItem?.queueItemId)
      : -1;
    queueListEl.replaceChildren();
    items.forEach((item, index) => {
      const li = document.createElement('li');
      if (index === currentIndex) li.classList.add('current');

      const titleSpan = document.createElement('span');
      titleSpan.className = 'title';
      const meta = item.track.metadata;
      titleSpan.textContent = meta.artist ? `${meta.title} — ${meta.artist}` : meta.title;
      titleSpan.addEventListener('click', () => {
        log('ui', `queue row clicked: index ${index}`, { title: meta.title });
        core.selectQueueItem(item.queueItemId).then(() => core.play());
      });
      li.appendChild(titleSpan);

      addButton(li, { label: '▲', disabled: index === 0, onClick: () => {
        log('ui', `move up: index ${index}`);
        core.reorderQueueItem(item.queueItemId, index - 1);
      } });
      addButton(li, { label: '▼', disabled: index === items.length - 1, onClick: () => {
        log('ui', `move down: index ${index}`);
        core.reorderQueueItem(item.queueItemId, index + 1);
      } });
      addButton(li, { label: '✕', onClick: () => {
        log('ui', `remove: index ${index}`, { title: meta.title });
        core.removeFromQueue(item.queueItemId);
      } });

      queueListEl.appendChild(li);
    });
  }

  /** @returns {void} */
  function updateShuffleRepeat() {
    const state = core.getState();
    shuffleEl.textContent = `Shuffle: ${state.shuffle ? 'on' : 'off'}`;
    repeatEl.textContent = `Repeat: ${state.repeatMode}`;
  }

  /**
   * @param {number} position
   * @param {number} duration
   * @returns {void}
   */
  function updateSeek(position, duration) {
    if (!scrubbing) {
      seekEl.max = String(Math.max(0, duration || 0));
      seekEl.value = String(position || 0);
    }
    timeEl.textContent = `${formatTime(position)} / ${formatTime(duration)}`;
  }

  /**
   * Starts playback after an open, if the config asks for it. Opening
   * appends to the queue rather than replacing it, so this deliberately
   * only ever starts an *idle* player — it never interrupts something
   * already playing or resumes something the listener paused.
   * @returns {Promise<void>}
   */
  async function autoPlayIfEnabled() {
    if (!config.autoPlayOnOpen) {
      log('ui', 'autoPlayOnOpen is false — queue updated, not starting playback');
      return;
    }
    if (core.getState().status !== 'idle') {
      log('ui', 'autoPlayOnOpen is true but player is not idle — leaving playback alone');
      return;
    }
    log('ui', 'autoPlayOnOpen is true and player is idle — starting playback');
    await core.play();
  }

  core.on('stateChanged', () => {
    log('core', 'stateChanged', summarizeState(core.getState()));
    updateStatus();
  });
  core.on('trackChanged', (/** @type {any} */ queueItem) => {
    log('core', 'trackChanged', {
      queueItemId: queueItem?.queueItemId,
      title: queueItem?.track.metadata.title,
      artist: queueItem?.track.metadata.artist,
      sourceId: queueItem?.track.sources[0]?.sourceId,
    });
    lastErrorText = undefined;
    updateStatus();
    renderQueue();
  });
  core.on('queueChanged', () => {
    const state = core.getState();
    const currentIndex = state.currentQueueItem
      ? state.queue.findIndex((item) => item.queueItemId === state.currentQueueItem?.queueItemId)
      : -1;
    log('core', 'queueChanged', {
      length: state.queue.length,
      currentIndex,
      shuffle: state.shuffle,
      repeatMode: state.repeatMode,
    });
    renderQueue();
    updateShuffleRepeat();
  });
  core.on('error', (/** @type {any} */ payload) => {
    log('core', 'ERROR', payload);
    const failedSources = Array.isArray(payload.failedSources) ? payload.failedSources : [];
    const detail = failedSources
      .map((/** @type {any} */ s) => `${s.pluginId}: ${s.reason}`)
      .join('; ');
    lastErrorText = detail ? `${payload.reason} (${detail})` : payload.reason;
    updateStatus();
  });
  let lastPositionLogAt = 0;
  core.on('positionChanged', (/** @type {any} */ payload) => {
    const now = Date.now();
    if (now - lastPositionLogAt >= POSITION_LOG_INTERVAL_MS) {
      lastPositionLogAt = now;
      log('core', 'position', {
        position: Math.round(payload.position),
        duration: Math.round(payload.duration),
      });
    }
    updateSeek(payload.position, payload.duration);
  });

  // Preload scripts run under Node, where an unhandled promise rejection
  // is fatal by default (crashes the renderer) rather than just logging —
  // unlike a plain browser page. Anything that slips past the try/catches
  // below (an unexpected error shape, a future code path that forgets one)
  // should surface as a visible status, not take the window down.
  process.on('unhandledRejection', (/** @type {any} */ reason) => {
    log('renderer', 'UNHANDLED REJECTION', reason);
    lastErrorText = `unhandled: ${reason instanceof Error ? reason.message : String(reason)}`;
    updateStatus();
  });
  window.addEventListener('error', (/** @type {ErrorEvent} */ event) => {
    log('renderer', 'UNCAUGHT ERROR', { message: event.message, filename: event.filename, lineno: event.lineno });
    lastErrorText = `unhandled: ${event.error instanceof Error ? event.error.message : String(event.error ?? event.message)}`;
    updateStatus();
  });

  // --- Connection forms ---------------------------------------------------
  // Credentials live only in these closures — never written to disk, a
  // cookie, or IPC'd anywhere beyond the redacted log lines below. Ported
  // from @unitrack/web-demo/main.js's identical handlers, with
  // console.log calls replaced by this file's IPC-backed log().

  let subsonicRegistered = false;
  requireElement('subsonic-connect').addEventListener('click', async () => {
    const baseUrl = requireInputElement('subsonic-baseurl').value.trim();
    const username = requireInputElement('subsonic-username').value;
    const password = requireInputElement('subsonic-password').value;
    if (!baseUrl || !username || !password) {
      requireElement('subsonic-status').textContent = 'fill in all fields';
      return;
    }
    if (subsonicRegistered) {
      requireElement('subsonic-status').textContent = 'already connected (reload to reconnect)';
      return;
    }
    core.registerSourceProvider(createSubsonicSourceProvider({ baseUrl, username, password }));
    subsonicRegistered = true;
    await reinitializePlugins();
    requireElement('subsonic-status').textContent = 'connected';
    log('ui', 'subsonic provider registered', { baseUrl, username });
  });

  let s3Registered = false;
  requireElement('s3-connect').addEventListener('click', async () => {
    const endpoint = requireInputElement('s3-endpoint').value.trim();
    const region = requireInputElement('s3-region').value.trim();
    const bucket = requireInputElement('s3-bucket').value.trim();
    const accessKeyId = requireInputElement('s3-access-key').value;
    const secretAccessKey = requireInputElement('s3-secret-key').value;
    const forcePathStyle = requireInputElement('s3-force-path-style').checked;
    if (!endpoint || !region || !bucket || !accessKeyId || !secretAccessKey) {
      requireElement('s3-status').textContent = 'fill in all fields';
      return;
    }
    if (s3Registered) {
      requireElement('s3-status').textContent = 'already connected (reload to reconnect)';
      return;
    }
    core.registerSourceProvider(createS3SourceProvider({
      endpoint, region, bucket, accessKeyId, secretAccessKey, forcePathStyle,
    }));
    s3Registered = true;
    await reinitializePlugins();
    requireElement('s3-status').textContent = 'connected';
    log('ui', 's3 provider registered', { endpoint, region, bucket, forcePathStyle });
  });

  // --- Add Track -----------------------------------------------------------

  requireElement('add-track').addEventListener('click', async () => {
    const title = requireInputElement('track-title').value.trim() || '(untitled)';
    const primaryProvider = requireSelectElement('primary-provider').value;
    const primaryKey = requireInputElement('primary-key').value.trim();
    const fallbackProvider = requireSelectElement('fallback-provider').value;
    const fallbackKey = requireInputElement('fallback-key').value.trim();

    if (!primaryKey) {
      log('ui', 'Add Track: primary key is required');
      return;
    }

    const kindFor = (/** @type {string} */ pluginId) => {
      if (pluginId === 'subsonic') return 'self-hosted';
      if (pluginId === 's3') return 'object-storage';
      return 'direct-url';
    };

    /** @type {import('@unitrack/core/types').SourceRef[]} */
    const sources = [
      { pluginId: primaryProvider, token: { pluginId: primaryProvider, token: primaryKey }, kind: kindFor(primaryProvider) },
    ];
    if (fallbackProvider && fallbackKey) {
      sources.push({
        pluginId: fallbackProvider,
        token: { pluginId: fallbackProvider, token: fallbackKey },
        kind: kindFor(fallbackProvider),
      });
    }

    await core.enqueue({
      id: crypto.randomUUID(),
      metadata: { artist: '', album: '', title },
      sources,
    });
    log('ui', 'track added', { title, sources: sources.length });
    await autoPlayIfEnabled();
  });

  requireElement('open-file').addEventListener('click', async () => {
    log('ui', 'Open File clicked');
    const filePath = await ipcRenderer.invoke('open-file-dialog');
    if (!filePath) {
      log('ui', 'Open File cancelled');
      return;
    }
    const title = filePath.split(/[\\/]/).pop() ?? filePath;
    await core.enqueue({
      id: filePath,
      metadata: { artist: '', album: '', title },
      sources: [{ pluginId: 'local-fs', token: { pluginId: 'local-fs', token: filePath }, kind: 'local' }],
    });
    log('ui', 'Open File: track appended', { title });
    await autoPlayIfEnabled();
  });

  requireElement('open-folder').addEventListener('click', async () => {
    log('ui', 'Open Folder clicked');
    const folderPath = await ipcRenderer.invoke('open-folder-dialog');
    if (!folderPath) {
      log('ui', 'Open Folder cancelled');
      return;
    }
    /** @type {import('@unitrack/core/types').LogicalTrack[]} */
    let tracks;
    const scanStartedAt = Date.now();
    try {
      log('ui', `scanning folder ${folderPath}`);
      tracks = await playlistProvider.fetchPlaylist({ pluginId: playlistProvider.id, playlistId: folderPath });
      log('ui', `scan found ${tracks.length} track(s) in ${Date.now() - scanStartedAt}ms`);
    } catch (err) {
      log('ui', 'scan FAILED', err);
      lastErrorText = `open-folder: ${err instanceof Error ? err.message : String(err)}`;
      updateStatus();
      return;
    }
    const enrichedTracks = await mapWithConcurrencyLimit(tracks, METADATA_FETCH_CONCURRENCY, async (track) => {
      const sourceRef = track.sources[0];
      if (!sourceRef) return track;
      const result = await ipcRenderer.invoke('fetch-metadata', sourceRef);
      // A failed tag read (corrupt/unsupported file) keeps the playlist
      // provider's filename-derived placeholder metadata rather than
      // failing the whole folder-open.
      if (!result?.ok) {
        // Never interpolate sourceRef.token.token (the raw, provider-owned
        // token value) into a log line — pluginId + the already-known
        // filename-derived title are enough to identify which track this
        // was, without carrying a value this project treats as always
        // redacted (see types.js's SourceToken doc comment).
        log('ui', `tags unavailable, keeping filename for "${track.metadata.title}" (pluginId: ${sourceRef.pluginId})`, result?.error);
        return track;
      }
      return { ...track, metadata: { ...track.metadata, ...result.metadata } };
    });
    log('ui', `enrichment done for ${enrichedTracks.length} track(s), appending to queue`);
    await core.enqueue(enrichedTracks);
    await autoPlayIfEnabled();
    log('ui', 'Open Folder complete');
  });

  /** @type {Array<[string, () => Promise<void>]>} */
  const transportButtons = [
    ['play', () => core.play()],
    ['pause', () => core.pause()],
    ['stop', () => core.stop()],
    ['prev', () => core.prev()],
    ['next', () => core.next()],
  ];
  for (const [id, action] of transportButtons) {
    requireElement(id).addEventListener('click', () => {
      log('ui', `${id} clicked`);
      action();
    });
  }

  for (const eventName of ['mousedown', 'touchstart']) {
    seekEl.addEventListener(eventName, () => {
      scrubbing = true;
    });
  }
  seekEl.addEventListener('change', () => {
    scrubbing = false;
    log('ui', `seek to ${seekEl.value}s`);
    core.seek(Number(seekEl.value));
  });

  volumeEl.value = String(core.getVolume());
  volumeEl.addEventListener('change', () => {
    // 'change' rather than 'input' for logging purposes: 'input' fires on
    // every pixel of slider drag, which would flood the log. The volume
    // itself is still applied on every 'input' below, so dragging stays
    // responsive.
    log('ui', `volume set to ${volumeEl.value}`);
  });
  volumeEl.addEventListener('input', () => {
    core.setVolume(Number(volumeEl.value));
  });

  shuffleEl.addEventListener('click', () => {
    const next = !core.getState().shuffle;
    log('ui', `shuffle -> ${next ? 'on' : 'off'}`);
    core.setShuffle(next);
  });

  repeatEl.addEventListener('click', () => {
    const currentIndex = REPEAT_CYCLE.indexOf(core.getState().repeatMode);
    const nextMode = REPEAT_CYCLE[(currentIndex + 1) % REPEAT_CYCLE.length];
    log('ui', `repeat -> ${nextMode}`);
    core.setRepeatMode(nextMode);
  });

  // Best-effort cleanup (closes engine-web-audio's AudioContext) — fire and
  // forget, since beforeunload cannot reliably await an async handler.
  window.addEventListener('beforeunload', () => {
    log('renderer', 'window closing, disposing core plugins');
    core.dispose().catch((err) => {
      log('renderer', 'core.dispose() failed', err instanceof Error ? err.message : String(err));
    });
  });

  updateStatus();
  updateShuffleRepeat();
  renderQueue();
  updateSeek(0, 0);
  log('renderer', 'preload wiring complete, UI ready');
});
