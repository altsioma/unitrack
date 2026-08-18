import { ipcRenderer } from 'electron';
import { CorePlayer } from '@unitrack/core';
import { createLocalFileSourceProvider } from '@unitrack/source-local-fs';
import { createWebAudioPlaybackEngine } from '@unitrack/engine-web-audio';
import { createLocalFolderPlaylistProvider } from '@unitrack/playlist-local-fs';

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
  core.registerPlaybackEngine(createWebAudioPlaybackEngine());
  core.setPolicy([{ kind: 'local' }]);
  log('renderer', 'core constructed; source-local-fs + engine-web-audio registered');

  // v0.2.0 contract: every registered plugin's initialize() must run before
  // the first play() — CorePlayer.play() throws PluginsNotInitializedError
  // otherwise. host here is deliberately minimal; nothing in this demo's
  // plugins reads config or host yet.
  await core.initializePlugins({
    log: (scope, message, detail) => log(`core:${scope}`, message, detail),
    config: {},
    host: { platform: 'electron', version: process.versions.electron },
  });
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
    const items = core.queue.getItems();
    const currentIndex = core.queue.getCurrentIndex();
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
        core.queue.setCurrentIndex(index);
        core.play();
      });
      li.appendChild(titleSpan);

      addButton(li, { label: '▲', disabled: index === 0, onClick: () => {
        log('ui', `move up: index ${index}`);
        core.queue.reorder(item.queueItemId, index - 1);
      } });
      addButton(li, { label: '▼', disabled: index === items.length - 1, onClick: () => {
        log('ui', `move down: index ${index}`);
        core.queue.reorder(item.queueItemId, index + 1);
      } });
      addButton(li, { label: '✕', onClick: () => {
        log('ui', `remove: index ${index}`, { title: meta.title });
        core.queue.remove(item.queueItemId);
      } });

      queueListEl.appendChild(li);
    });
  }

  /** @returns {void} */
  function updateShuffleRepeat() {
    shuffleEl.textContent = `Shuffle: ${core.queue.isShuffleEnabled() ? 'on' : 'off'}`;
    repeatEl.textContent = `Repeat: ${core.queue.getRepeatMode()}`;
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
    log('core', 'queueChanged', {
      length: core.queue.getItems().length,
      currentIndex: core.queue.getCurrentIndex(),
      shuffle: core.queue.isShuffleEnabled(),
      repeatMode: core.queue.getRepeatMode(),
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

  requireElement('open-file').addEventListener('click', async () => {
    log('ui', 'Open File clicked');
    const filePath = await ipcRenderer.invoke('open-file-dialog');
    if (!filePath) {
      log('ui', 'Open File cancelled');
      return;
    }
    const title = filePath.split(/[\\/]/).pop() ?? filePath;
    core.queue.add({
      id: filePath,
      metadata: { artist: '', album: '', title },
      sources: [{ pluginId: 'local-fs', sourceId: filePath, kind: 'local' }],
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
        log('ui', `tags unavailable, keeping filename for ${sourceRef.sourceId}`, result?.error);
        return track;
      }
      return { ...track, metadata: { ...track.metadata, ...result.metadata } };
    });
    log('ui', `enrichment done for ${enrichedTracks.length} track(s), appending to queue`);
    core.queue.add(enrichedTracks);
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
    const next = !core.queue.isShuffleEnabled();
    log('ui', `shuffle -> ${next ? 'on' : 'off'}`);
    core.queue.setShuffle(next);
  });

  repeatEl.addEventListener('click', () => {
    const currentIndex = REPEAT_CYCLE.indexOf(core.queue.getRepeatMode());
    const nextMode = REPEAT_CYCLE[(currentIndex + 1) % REPEAT_CYCLE.length];
    log('ui', `repeat -> ${nextMode}`);
    core.queue.setRepeatMode(nextMode);
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
