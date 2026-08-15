import { ipcRenderer } from 'electron';
import { CorePlayer } from '@unitrack/core';
import { createLocalFileSourceProvider } from '@unitrack/source-local-fs';
import { createWebAudioPlaybackEngine } from '@unitrack/engine-web-audio';

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
function requireElement(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id} element`);
  return el;
}

const core = new CorePlayer();
core.registerSourceProvider(createLocalFileSourceProvider());
core.registerPlaybackEngine(createWebAudioPlaybackEngine());
core.setPolicy([{ kind: 'local' }]);

const statusEl = requireElement('status');

/** @returns {void} */
function updateStatus() {
  const state = core.getState();
  const title = state.currentQueueItem?.track.metadata.title ?? '(no track)';
  statusEl.textContent = `${state.status} — ${title}`;
}

core.on('stateChanged', updateStatus);
core.on('trackChanged', updateStatus);
core.on('error', (/** @type {any} */ payload) => {
  statusEl.textContent = `error: ${payload.reason}`;
});

requireElement('open-file').addEventListener('click', async () => {
  const filePath = await ipcRenderer.invoke('open-file-dialog');
  if (!filePath) return;
  const title = filePath.split(/[\\/]/).pop() ?? filePath;
  core.queue.clear();
  core.queue.add({
    id: filePath,
    metadata: { artist: '', album: '', title },
    sources: [{ pluginId: 'local-fs', sourceId: filePath, kind: 'local' }],
  });
  await core.play();
});

requireElement('play').addEventListener('click', () => core.play());
requireElement('pause').addEventListener('click', () => core.pause());
requireElement('stop').addEventListener('click', () => core.stop());

updateStatus();
