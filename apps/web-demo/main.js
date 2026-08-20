import { CorePlayer } from '@unitrack/core';
import {
  createSubsonicSourceProvider,
  createS3SourceProvider,
  createDirectUrlSourceProvider,
  createAudioQueuePlaybackEngine,
} from './plugins.js';

// --- DOM helpers -----------------------------------------------------------
// Same small helpers @unitrack/electron-demo's preload.mjs already
// established — reused directly rather than redesigned, since this app's
// whole point is to prove the browser/import-map pipeline, not to explore
// new UI architecture (see design spec's Interface section).

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

// No IPC/main process here (unlike @unitrack/electron-demo's preload.mjs,
// which logs over a synchronous Electron channel so a crashing renderer
// still leaves a trustworthy trailing log line) — plain console logging is
// sufficient and simpler by necessity, not by omission.
/**
 * @param {string} scope
 * @param {string} message
 * @param {unknown} [detail]
 * @returns {void}
 */
function log(scope, message, detail) {
  if (detail === undefined) {
    console.log(`[${scope}]`, message);
    return;
  }
  console.log(`[${scope}]`, message, detail);
}

const core = new CorePlayer();

// A single catch-all policy rule (no kind/pluginId filter) matches every
// SourceRef on a track in the order LogicalTrack.sources lists them —
// giving exactly "try the primary source, then the fallback" semantics
// driven by the Add Track form's own primary/fallback ordering below,
// regardless of which provider kind either one happens to be. A
// kind-first policy (e.g. [{ kind: 'self-hosted' }, { kind: 'object-storage' }],
// the shape the root README's architecture example uses) would instead
// always prefer one provider kind over the other for every track — wrong
// for this app's per-track primary/fallback choice.
core.setPolicy([{}]);

core.registerPlaybackEngine(createAudioQueuePlaybackEngine());
log('main', 'engine-audio-queue registered');

// Unlike Subsonic/S3, this provider takes no config at all — the
// SourceRef.token.token a caller supplies already is the complete URL —
// so there's no connection form for it; it's simply always available.
core.registerSourceProvider(createDirectUrlSourceProvider());
log('main', 'direct-url provider registered');

/**
 * core.initializePlugins() must run before the first play() (v0.4
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
    host: { platform: 'web', version: navigator.userAgent },
  });
}

await reinitializePlugins();
log('main', 'core constructed; engine-audio-queue initialized');

// --- Connection forms --------------------------------------------------
// Credentials live only in these closures — never written to
// localStorage, a cookie, or any file (see design spec's Scope).

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
});

// --- Transport / status wiring --------------------------------------------
// Adapted directly from @unitrack/electron-demo/preload.mjs's equivalent
// block — see design spec's Interface section.

const statusEl = requireElement('status');
const queueListEl = requireElement('queue-list');
const seekEl = requireInputElement('seek');
const timeEl = requireElement('time');
const volumeEl = requireInputElement('volume');

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
    li.textContent = item.track.metadata.title;
    li.addEventListener('click', () => {
      log('ui', `queue row clicked: index ${index}`, { title: item.track.metadata.title });
      core.selectQueueItem(item.queueItemId).then(() => core.play());
    });
    queueListEl.appendChild(li);
  });
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

core.on('stateChanged', () => {
  updateStatus();
});
core.on('trackChanged', (/** @type {any} */ queueItem) => {
  log('core', 'trackChanged', { title: queueItem?.track.metadata.title });
  lastErrorText = undefined;
  updateStatus();
  renderQueue();
});
core.on('queueChanged', () => {
  renderQueue();
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
core.on('positionChanged', (/** @type {any} */ payload) => {
  updateSeek(payload.position, payload.duration);
});

window.addEventListener('unhandledrejection', (/** @type {PromiseRejectionEvent} */ event) => {
  log('main', 'UNHANDLED REJECTION', event.reason);
  lastErrorText = `unhandled: ${event.reason instanceof Error ? event.reason.message : String(event.reason)}`;
  updateStatus();
});

/** @type {Array<[string, () => Promise<void>]>} */
const transportButtons = [
  ['play', () => core.play()],
  ['pause', () => core.pause()],
  ['stop', () => core.stop()],
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
volumeEl.addEventListener('input', () => {
  core.setVolume(Number(volumeEl.value));
});

window.addEventListener('beforeunload', () => {
  core.dispose().catch((err) => {
    log('main', 'core.dispose() failed', err instanceof Error ? err.message : String(err));
  });
});

updateStatus();
renderQueue();
updateSeek(0, 0);
log('main', 'wiring complete, UI ready');
