// Host plugin manifest for @unitrack/web-demo — mirrors
// apps/electron-demo/plugins.js's PLUGIN_MANIFEST pattern (the one place
// this host's plugin set is composed), minus the per-process split that
// file needs: there is only one process here, the browser page itself.

import { createSubsonicSourceProvider } from '@unitrack/source-subsonic';
import { createS3SourceProvider } from '@unitrack/source-s3';
import { createAudioQueuePlaybackEngine } from '@unitrack/engine-audio-queue';

/**
 * @typedef {Object} PluginManifestEntry
 * @property {'source' | 'engine'} category
 * @property {string} packageName
 */

/** @type {PluginManifestEntry[]} */
export const PLUGIN_MANIFEST = [
  { category: 'source', packageName: '@unitrack/source-subsonic' },
  { category: 'source', packageName: '@unitrack/source-s3' },
  { category: 'engine', packageName: '@unitrack/engine-audio-queue' },
];

export { createSubsonicSourceProvider, createS3SourceProvider, createAudioQueuePlaybackEngine };
