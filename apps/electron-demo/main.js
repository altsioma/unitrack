import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
