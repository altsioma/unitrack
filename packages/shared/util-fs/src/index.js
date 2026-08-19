import { basename, extname } from 'node:path';

/**
 * Derives a human-readable title from a file path by stripping its
 * extension. The shared fallback used whenever a real tag/title isn't
 * available — e.g. a playlist scan that hasn't read tags yet, or a
 * metadata reader falling back on an untagged file.
 *
 * @param {string} filePath
 * @returns {string}
 */
export function titleFromFilename(filePath) {
  const name = basename(filePath);
  const ext = extname(name);
  return ext ? name.slice(0, -ext.length) : name;
}
