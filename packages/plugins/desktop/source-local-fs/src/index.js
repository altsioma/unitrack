import { access, constants, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { extname } from 'node:path';
import { CONTRACT_VERSION } from '@unitrack/core/types';

// Extension -> mime map for the audio formats this provider is expected to
// see on disk. ResolvedSource.mime is required (not optional) under the
// v0.3.0 contract, so an unrecognized extension still needs a value —
// 'application/octet-stream' documents "we don't know", rather than the
// provider throwing or omitting the field.
/** @type {Record<string, string>} */
const MIME_BY_EXTENSION = {
  flac: 'audio/flac',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  wma: 'audio/x-ms-wma',
};

/**
 * @param {string} ext
 * @returns {string}
 */
function mimeForExtension(ext) {
  return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream';
}

/**
 * @param {import('@unitrack/core/types').SourceRef} ref
 * @returns {Promise<import('@unitrack/core/types').ResolvedSource>}
 */
async function resolveRef(ref) {
  const path = ref.token.token;
  await access(path, constants.R_OK);
  const stats = await stat(path);
  if (!stats.isFile()) {
    throw new Error(`Not a regular file: ${path}`);
  }
  const url = pathToFileURL(path).href;
  const ext = extname(path).slice(1).toLowerCase();
  return { kind: 'url', url, mime: mimeForExtension(ext) };
}

/** @returns {import('@unitrack/core/types').SourceProvider} */
export function createLocalFileSourceProvider() {
  return {
    id: 'local-fs',
    kind: 'local',
    contractVersion: CONTRACT_VERSION,

    // Local files are readable without any network round-trip, and a path
    // on disk is stable enough that there is no separate "revalidate this
    // token" flow worth modelling — revalidate() below just re-attempts the
    // same filesystem check.
    capabilities: { offline: true, requiresRevalidation: false },

    /**
     * @param {import('@unitrack/core/types').PluginContext} ctx
     * @returns {Promise<void>}
     */
    async initialize(ctx) {},

    /** @returns {Promise<void>} */
    async dispose() {},

    /**
     * @param {import('@unitrack/core/types').SourceRef} ref
     * @returns {Promise<boolean>}
     */
    async canResolve(ref) {
      return ref.pluginId === 'local-fs';
    },
    /**
     * @param {import('@unitrack/core/types').SourceRef} ref
     * @returns {Promise<import('@unitrack/core/types').ResolvedSource>}
     */
    async resolve(ref) {
      return resolveRef(ref);
    },
    /**
     * @param {import('@unitrack/core/types').SourceToken} token
     * @returns {Promise<import('@unitrack/core/types').RevalidationResult>}
     */
    async revalidate(token) {
      try {
        await resolveRef({ pluginId: 'local-fs', token, kind: 'local' });
        return { valid: true, token };
      } catch (err) {
        return { valid: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
