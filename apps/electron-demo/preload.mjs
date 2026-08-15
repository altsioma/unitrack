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

window.addEventListener('DOMContentLoaded', () => {
  const core = new CorePlayer();
  core.registerSourceProvider(createLocalFileSourceProvider());
  core.registerPlaybackEngine(createWebAudioPlaybackEngine());
  core.setPolicy([{ kind: 'local' }]);

  const statusEl = requireElement('status');
  /** @type {string | undefined} */
  let lastErrorText;

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

  core.on('stateChanged', updateStatus);
  core.on('trackChanged', () => {
    lastErrorText = undefined;
    updateStatus();
  });
  core.on('error', (/** @type {any} */ payload) => {
    const failedSources = Array.isArray(payload.failedSources) ? payload.failedSources : [];
    const detail = failedSources
      .map((/** @type {any} */ s) => `${s.pluginId}: ${s.reason}`)
      .join('; ');
    lastErrorText = detail ? `${payload.reason} (${detail})` : payload.reason;
    updateStatus();
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
});
