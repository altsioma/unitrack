// Host plugin manifest for @unitrack/electron-demo — per the v0.3 design
// spec's host-manifest requirement, this is the one place this host's
// plugin set is composed, so "which plugins does this host use, and in
// which Electron process does each run" is answered by reading one file
// instead of grepping main.js/preload.mjs for imports.
//
// Electron's main/preload process split means the actual
// registerXProvider()/registerPlaybackEngine() calls still happen in
// main.js and preload.mjs respectively (a plugin that touches DOM/Web
// Audio globals, like engine-web-audio, can only be constructed in the
// preload/renderer context; metadata-local-fs's tag reading runs in the
// main process, invoked via the existing 'fetch-metadata' IPC channel) —
// both files import their factories from here rather than reaching into
// each plugin package directly.
//
// This list is metadata only (package name, plugin category, which
// process constructs it) rather than eagerly instantiating every plugin
// to read its .capabilities — several of these factories (engine-web-audio
// in particular) require browser/DOM globals that don't exist in the main
// process, so "construct everything up front to introspect it" isn't
// available without process-specific branching that would defeat the
// point of a single shared manifest. A plugin's actual capabilities are
// still visible the normal way: read off the object returned by its
// factory, right where it's registered.

import { createLocalFileSourceProvider } from '@unitrack/source-local-fs';
import { createSubsonicSourceProvider } from '@unitrack/source-subsonic';
import { createS3SourceProvider } from '@unitrack/source-s3';
import { createDirectUrlSourceProvider } from '@unitrack/source-direct-url';
import { createWebAudioPlaybackEngine } from '@unitrack/engine-web-audio';
import { createLocalFolderPlaylistProvider } from '@unitrack/playlist-local-fs';
import { createLocalFileMetadataProvider } from '@unitrack/metadata-local-fs';

/**
 * @typedef {Object} PluginManifestEntry
 * @property {'source' | 'engine' | 'metadata' | 'playlist'} category
 * @property {string} packageName
 * @property {'main' | 'preload'} process - which Electron process constructs and registers this plugin
 */

/** @type {PluginManifestEntry[]} */
export const PLUGIN_MANIFEST = [
  { category: 'source', packageName: '@unitrack/source-local-fs', process: 'preload' },
  { category: 'source', packageName: '@unitrack/source-subsonic', process: 'preload' },
  { category: 'source', packageName: '@unitrack/source-s3', process: 'preload' },
  { category: 'source', packageName: '@unitrack/source-direct-url', process: 'preload' },
  { category: 'engine', packageName: '@unitrack/engine-web-audio', process: 'preload' },
  { category: 'playlist', packageName: '@unitrack/playlist-local-fs', process: 'preload' },
  { category: 'metadata', packageName: '@unitrack/metadata-local-fs', process: 'main' },
];

// Re-exported so main.js/preload.mjs each import only the factory (or
// factories) relevant to their own process from this one module.
export {
  createLocalFileSourceProvider,
  createSubsonicSourceProvider,
  createS3SourceProvider,
  createDirectUrlSourceProvider,
  createWebAudioPlaybackEngine,
  createLocalFolderPlaylistProvider,
  createLocalFileMetadataProvider,
};
