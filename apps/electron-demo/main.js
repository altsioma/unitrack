import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalFileMetadataProvider } from '@unitrack/metadata-local-fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Tag reading lives in the main process, not the renderer, because
// `music-metadata` lazily `import()`s its per-format parser — and a
// dynamic import() inside an ESM preload script hard-crashes Electron
// 31's renderer (render-process-gone { reason: 'crashed', exitCode: 5 },
// no catchable exception). This reproduces with a bare
// `await import('node:path')`, so it is the dynamic import itself, not
// anything specific to music-metadata or to any one audio file. The main
// process has no such problem. See the design spec for the full writeup.
const metadataProvider = createLocalFileMetadataProvider();

/** @returns {void} */
function createWindow() {
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

  // Mirror renderer/preload console output (console.log/warn/error from
  // index.html or preload.mjs) into this same terminal, so debugging
  // doesn't require opening DevTools separately.
  win.webContents.on('console-message', (event, level, message, line, sourceId) => {
    console.log(`[renderer] ${message} (${sourceId}:${line})`);
  });
  win.webContents.on('unresponsive', () => {
    console.error('[main] renderer window became unresponsive');
  });
  win.webContents.on('responsive', () => {
    console.error('[main] renderer window became responsive again');
  });
}

// Fires when the renderer's process itself goes down (crash, OOM kill,
// killed by the OS, etc.) — the actual event to look at for "the app
// crashed" reports, since a plain JS exception alone doesn't produce this.
app.on('render-process-gone', (event, webContents, details) => {
  console.error('[main] renderer process gone:', details);
});

ipcMain.handle('open-file-dialog', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('open-folder-dialog', async () => {
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
 */
ipcMain.handle('fetch-metadata', async (event, /** @type {any} */ sourceRef) => {
  if (!metadataProvider.fetchForSource) {
    return { ok: false, error: 'metadata provider has no fetchForSource' };
  }
  try {
    const metadata = await metadataProvider.fetchForSource(sourceRef);
    // coverArtUrl is a base64 data: URL (up to a few MB for embedded album
    // art). Nothing in this demo renders it (see the spec's Out of Scope),
    // so it is dropped here rather than serialized across IPC and held in
    // the renderer's queue for every track.
    const { coverArtUrl, ...displayMetadata } = metadata;
    return { ok: true, metadata: displayMetadata };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
