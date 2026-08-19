import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createLocalFileMetadataProvider } from './plugins.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Logging -------------------------------------------------------------
//
// This app is a development-only demo (`electron .`, never packaged), and
// it is the only place where @unitrack's packages run in a real host. It
// therefore logs verbosely and unconditionally, by design — see the design
// spec's "Logging" section. The folder-open crash that motivated this took
// several rounds to diagnose purely because there was nothing in the
// terminal; the rule now is that anything worth knowing during a crash
// should already be in the log before the crash happens.

const startedAt = Date.now();

/**
 * @param {string} scope
 * @param {string} message
 * @param {unknown} [detail]
 * @returns {void}
 */
function log(scope, message, detail) {
  const elapsed = String(Date.now() - startedAt).padStart(6, ' ');
  const line = `[${elapsed}ms] [${scope}] ${message}`;
  if (detail === undefined) {
    console.log(line);
    return;
  }
  console.log(line, detail);
}

const CONSOLE_LEVELS = ['verbose', 'info', 'warning', 'error'];

log('main', 'starting', {
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  platform: `${process.platform}/${process.arch}`,
});

// Logged rather than left to the default handling, so an unexpected failure
// in the main process leaves a trace instead of a silent exit.
process.on('uncaughtException', (err) => {
  log('main', 'UNCAUGHT EXCEPTION', err);
});
process.on('unhandledRejection', (reason) => {
  log('main', 'UNHANDLED REJECTION', reason);
});

// Renderer-side logging arrives here over a synchronous channel: sendSync
// blocks the renderer until this handler has run, so the last line printed
// is reliably the last step the renderer actually reached. Asynchronous
// logging (including console-message mirroring) can lose its final messages
// when the renderer dies instantly — exactly when they matter most.
ipcMain.on('renderer-log', (event, /** @type {any} */ payload) => {
  log(payload?.scope ?? 'renderer', payload?.message ?? String(payload), payload?.detail);
  event.returnValue = null;
});

// --- Config --------------------------------------------------------------
//
// Read once at startup from config.json next to this file. Unknown keys are
// ignored and missing ones fall back to the defaults below, so a partial or
// absent config.json is not an error — the app still starts with sane
// behaviour. Deliberately minimal: one key, added because it was actually
// wanted, rather than a speculative settings surface.

/** @type {{ autoPlayOnOpen: boolean }} */
const DEFAULT_CONFIG = {
  // Whether opening a file or a folder immediately starts playback.
  // Defaults to false: opening now only appends to the queue (see
  // Implementation Decision 1), so auto-starting would take over the
  // speakers every time you add something.
  autoPlayOnOpen: false,
};

/** @returns {{ autoPlayOnOpen: boolean }} */
function loadConfig() {
  const configPath = path.join(__dirname, 'config.json');
  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
    const config = { ...DEFAULT_CONFIG, ...parsed };
    log('config', `loaded ${configPath}`, config);
    return config;
  } catch (err) {
    log('config', `could not read ${configPath}, using defaults`, {
      reason: err instanceof Error ? err.message : String(err),
      defaults: DEFAULT_CONFIG,
    });
    return { ...DEFAULT_CONFIG };
  }
}

const config = loadConfig();

// Synchronous on purpose: the renderer reads this once during its own
// startup, and a blocking read keeps the preload's wiring straightforward
// (no async config plumbing before the UI can be built).
ipcMain.on('get-config', (event) => {
  event.returnValue = config;
});

const metadataProvider = createLocalFileMetadataProvider();
// Not gated behind CorePlayer.initializePlugins() — this provider isn't
// registered with CorePlayer (it's used directly via fetch-metadata below),
// so its initialize() is called here instead, once, at startup.
metadataProvider.initialize({
  log,
  config: {},
  host: { platform: 'electron', version: process.versions.electron },
}).catch((err) => log('main', 'metadataProvider.initialize() failed', err));

/** @returns {void} */
function createWindow() {
  log('main', 'creating window');
  const win = new BrowserWindow({
    width: 640,
    height: 640,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      preload: path.join(__dirname, 'preload.mjs'),
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));

  const wc = win.webContents;

  // Mirror renderer console output (console.log/warn/error from index.html
  // or preload.mjs) into this same terminal, so debugging doesn't require
  // opening DevTools separately.
  wc.on('console-message', (event, level, message, line, sourceId) => {
    log('renderer-console', `${CONSOLE_LEVELS[level] ?? level}: ${message} (${sourceId}:${line})`);
  });
  wc.on('did-finish-load', () => log('main', 'renderer finished loading'));
  wc.on('dom-ready', () => log('main', 'renderer DOM ready'));
  wc.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    log('main', 'renderer FAILED to load', { errorCode, errorDescription, validatedURL });
  });
  // A preload script that throws during evaluation fails silently otherwise
  // — the window just comes up with none of its wiring attached.
  wc.on('preload-error', (event, preloadPath, error) => {
    log('main', 'PRELOAD ERROR', { preloadPath, error });
  });
  wc.on('unresponsive', () => log('main', 'renderer UNRESPONSIVE'));
  wc.on('responsive', () => log('main', 'renderer responsive again'));
  wc.on('destroyed', () => log('main', 'renderer destroyed'));
}

// Fires when the renderer's process itself goes down (crash, OOM kill,
// killed by the OS, etc.) — the actual event to look at for "the app
// crashed" reports, since a plain JS exception alone doesn't produce this.
app.on('render-process-gone', (event, webContents, details) => {
  log('main', 'RENDERER PROCESS GONE', details);
});
app.on('child-process-gone', (event, details) => {
  log('main', 'CHILD PROCESS GONE', details);
});

/**
 * A JSON.stringify replacer for this file's IPC request-argument logging:
 * blanks exactly the fields the project treats as always-redacted —
 * SourceToken.token (the opaque, provider-owned value; see types.js's
 * SourceToken doc comment — not necessarily secret for every provider, but
 * never assumed safe to log) and ResolvedSource.headers (request headers,
 * which may carry credentials) — wherever they appear in an argument list,
 * however deeply nested. Generic on purpose: handleWithLogging wraps every
 * IPC channel, present and future, not just the ones known today to take a
 * SourceRef.
 * @param {string} key
 * @param {unknown} value
 * @returns {unknown}
 */
function redactingReplacer(key, value) {
  if (key === 'token' && typeof value === 'string') return '[redacted]';
  if (key === 'headers' && value && typeof value === 'object') return '[redacted]';
  return value;
}

/**
 * Wraps an IPC handler so every call logs its arguments, its outcome, and
 * how long it took, without each handler repeating that boilerplate.
 * @param {string} channel
 * @param {(event: Electron.IpcMainInvokeEvent, ...args: any[]) => Promise<any>} handler
 * @returns {void}
 */
function handleWithLogging(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    const calledAt = Date.now();
    log('ipc', `${channel} <- ${JSON.stringify(args, redactingReplacer)}`);
    try {
      const result = await handler(event, ...args);
      log('ipc', `${channel} -> ok in ${Date.now() - calledAt}ms`, result);
      return result;
    } catch (err) {
      log('ipc', `${channel} -> THREW in ${Date.now() - calledAt}ms`, err);
      throw err;
    }
  });
}

handleWithLogging('open-file-dialog', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

handleWithLogging('open-folder-dialog', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

/**
 * Reads tags for one already-known local file. Returns a result object
 * rather than throwing, so a single unreadable/corrupt file degrades to
 * the caller's placeholder metadata instead of rejecting the IPC call.
 *
 * This runs in the main process, not the renderer, because `music-metadata`
 * lazily `import()`s its per-format parser — and a dynamic import() inside
 * an ESM preload script hard-crashes Electron 31's renderer
 * (render-process-gone { reason: 'crashed', exitCode: 5 }, no catchable
 * exception). This reproduces with a bare `await import('node:path')`, so
 * it is the dynamic import itself, not anything specific to music-metadata
 * or to any one audio file. The main process has no such problem. See the
 * design spec for the full writeup.
 */
handleWithLogging('fetch-metadata', async (event, /** @type {any} */ sourceRef) => {
  if (!metadataProvider.fetchForSource) {
    return { ok: false, error: 'metadata provider has no fetchForSource' };
  }
  try {
    const metadata = await metadataProvider.fetchForSource(sourceRef);
    // coverArtUrl is a base64 data: URL (up to a few MB for embedded album
    // art). Nothing in this demo renders it (see the spec's Out of Scope),
    // so it is dropped here rather than serialized across IPC and held in
    // the renderer's queue for every track. Its size is logged instead, so
    // it stays visible that it was read and deliberately discarded.
    const { coverArtUrl, ...displayMetadata } = metadata;
    return {
      ok: true,
      metadata: displayMetadata,
      coverArtChars: coverArtUrl ? coverArtUrl.length : 0,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

app.whenReady().then(() => {
  log('main', 'app ready');
  createWindow();
});

app.on('window-all-closed', () => {
  log('main', 'all windows closed');
  if (process.platform !== 'darwin') app.quit();
});
