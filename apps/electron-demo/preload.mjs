import { ipcRenderer } from 'electron';
import { CorePlayer } from '@unitrack/core';
import { createLocalFileSourceProvider } from '@unitrack/source-local-fs';
import { createWebAudioPlaybackEngine } from '@unitrack/engine-web-audio';
import { createLocalFolderPlaylistProvider } from '@unitrack/playlist-local-fs';
import { createLocalFileMetadataProvider } from '@unitrack/metadata-local-fs';

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

// Overridable so the folder-open crash can be bisected without a rebuild:
// running with UNITRACK_METADATA_CONCURRENCY=1 serializes tag reads, which
// separates "one specific file kills the renderer" from "N concurrent
// parseFile calls kill it". Defaults to 1 while this is being diagnosed.
const METADATA_FETCH_CONCURRENCY =
  Number(process.env.UNITRACK_METADATA_CONCURRENCY) || 1;

/**
 * Blocking log to the main process — see main.js's 'debug-log' handler for
 * why this is synchronous. Temporary diagnostic for the folder-open crash.
 * @param {string} message
 * @returns {void}
 */
function debugLog(message) {
  try {
    ipcRenderer.sendSync('debug-log', message);
  } catch {
    // Never let diagnostics themselves break the app.
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const core = new CorePlayer();
  core.registerSourceProvider(createLocalFileSourceProvider());
  core.registerPlaybackEngine(createWebAudioPlaybackEngine());
  core.setPolicy([{ kind: 'local' }]);

  const playlistProvider = createLocalFolderPlaylistProvider();
  const metadataProvider = createLocalFileMetadataProvider();

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
        core.queue.setCurrentIndex(index);
        core.play();
      });
      li.appendChild(titleSpan);

      addButton(li, { label: '▲', disabled: index === 0, onClick: () => core.queue.reorder(item.queueItemId, index - 1) });
      addButton(li, { label: '▼', disabled: index === items.length - 1, onClick: () => core.queue.reorder(item.queueItemId, index + 1) });
      addButton(li, { label: '✕', onClick: () => core.queue.remove(item.queueItemId) });

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

  /** @returns {Promise<void>} */
  async function maybeAutoPlay() {
    if (core.getState().status === 'idle') {
      await core.play();
    }
  }

  core.on('stateChanged', updateStatus);
  core.on('trackChanged', () => {
    lastErrorText = undefined;
    updateStatus();
    renderQueue();
  });
  core.on('queueChanged', () => {
    renderQueue();
    updateShuffleRepeat();
  });
  core.on('error', (/** @type {any} */ payload) => {
    const failedSources = Array.isArray(payload.failedSources) ? payload.failedSources : [];
    const detail = failedSources
      .map((/** @type {any} */ s) => `${s.pluginId}: ${s.reason}`)
      .join('; ');
    lastErrorText = detail ? `${payload.reason} (${detail})` : payload.reason;
    updateStatus();
  });
  core.on('positionChanged', (/** @type {any} */ payload) => {
    updateSeek(payload.position, payload.duration);
  });

  // Preload scripts run under Node, where an unhandled promise rejection
  // is fatal by default (crashes the renderer) rather than just logging —
  // unlike a plain browser page. Anything that slips past the try/catches
  // below (an unexpected error shape, a future code path that forgets one)
  // should surface as a visible status, not take the window down.
  process.on('unhandledRejection', (/** @type {any} */ reason) => {
    lastErrorText = `unhandled: ${reason instanceof Error ? reason.message : String(reason)}`;
    updateStatus();
  });
  window.addEventListener('error', (/** @type {ErrorEvent} */ event) => {
    lastErrorText = `unhandled: ${event.error instanceof Error ? event.error.message : String(event.error ?? event.message)}`;
    updateStatus();
  });

  requireElement('open-file').addEventListener('click', async () => {
    const filePath = await ipcRenderer.invoke('open-file-dialog');
    if (!filePath) return;
    const title = filePath.split(/[\\/]/).pop() ?? filePath;
    core.queue.add({
      id: filePath,
      metadata: { artist: '', album: '', title },
      sources: [{ pluginId: 'local-fs', sourceId: filePath, kind: 'local' }],
    });
    await maybeAutoPlay();
  });

  requireElement('open-folder').addEventListener('click', async () => {
    debugLog('open-folder: invoking dialog');
    const folderPath = await ipcRenderer.invoke('open-folder-dialog');
    debugLog(`open-folder: dialog returned ${folderPath ?? '(cancelled)'}`);
    if (!folderPath) return;
    /** @type {import('@unitrack/core/types').LogicalTrack[]} */
    let tracks;
    try {
      debugLog(`open-folder: scanning folder (tag-read concurrency ${METADATA_FETCH_CONCURRENCY})`);
      tracks = await playlistProvider.fetchPlaylist({ pluginId: playlistProvider.id, playlistId: folderPath });
      debugLog(`open-folder: scan found ${tracks.length} track(s)`);
    } catch (err) {
      debugLog(`open-folder: scan FAILED: ${err instanceof Error ? err.message : String(err)}`);
      lastErrorText = `open-folder: ${err instanceof Error ? err.message : String(err)}`;
      updateStatus();
      return;
    }
    const enrichedTracks = await mapWithConcurrencyLimit(tracks, METADATA_FETCH_CONCURRENCY, async (track) => {
      const sourceRef = track.sources[0];
      if (!sourceRef || !metadataProvider.fetchForSource) return track;
      try {
        debugLog(`open-folder: reading tags of ${sourceRef.sourceId}`);
        const metadata = await metadataProvider.fetchForSource(sourceRef);
        debugLog(`open-folder: tags OK for ${sourceRef.sourceId}`);
        // coverArtUrl is a base64 data: URL — for a track with embedded
        // album art this can be hundreds of KB to a few MB per track, and
        // nothing in this app renders it (see spec's Out of Scope). Folder
        // opens with many such tracks were observed OOM-crashing the
        // renderer's V8 heap (Electron reports this as
        // render-process-gone reason 'crashed', not 'oom' — a known
        // Electron/macOS misreport, electron/electron#40426) purely from
        // holding all that unused image data in the queue at once.
        // Dropping it here costs nothing, since it's unused.
        const { coverArtUrl, ...displayMetadata } = metadata;
        return { ...track, metadata: { ...track.metadata, ...displayMetadata } };
      } catch (err) {
        // Tag read failed for this one file (corrupt/unsupported) — keep
        // the playlist provider's filename-derived placeholder metadata
        // rather than failing the whole folder-open.
        debugLog(`open-folder: tags FAILED for ${sourceRef.sourceId}: ${err instanceof Error ? err.message : String(err)}`);
        return track;
      }
    });
    debugLog('open-folder: enrichment done, adding to queue');
    core.queue.add(enrichedTracks);
    debugLog('open-folder: queue updated, maybe autoplay');
    await maybeAutoPlay();
    debugLog('open-folder: done');
  });

  requireElement('play').addEventListener('click', () => core.play());
  requireElement('pause').addEventListener('click', () => core.pause());
  requireElement('stop').addEventListener('click', () => core.stop());
  requireElement('prev').addEventListener('click', () => core.prev());
  requireElement('next').addEventListener('click', () => core.next());

  for (const eventName of ['mousedown', 'touchstart']) {
    seekEl.addEventListener(eventName, () => {
      scrubbing = true;
    });
  }
  seekEl.addEventListener('change', () => {
    scrubbing = false;
    core.seek(Number(seekEl.value));
  });

  volumeEl.value = String(core.getVolume());
  volumeEl.addEventListener('input', () => {
    core.setVolume(Number(volumeEl.value));
  });

  shuffleEl.addEventListener('click', () => {
    core.queue.setShuffle(!core.queue.isShuffleEnabled());
  });

  repeatEl.addEventListener('click', () => {
    const currentIndex = REPEAT_CYCLE.indexOf(core.queue.getRepeatMode());
    const nextMode = REPEAT_CYCLE[(currentIndex + 1) % REPEAT_CYCLE.length];
    core.queue.setRepeatMode(nextMode);
  });

  updateStatus();
  updateShuffleRepeat();
  renderQueue();
  updateSeek(0, 0);
});
