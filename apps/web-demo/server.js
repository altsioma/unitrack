// A small static-file + import-map dev server — no bundler. See
// docs/superpowers/specs/2026-08-20-web-demo-design.md's "Why import
// maps, not a bundler" and "Server" sections for the full rationale.
// Every @unitrack package is plain ESM with bare specifiers
// (`import { CorePlayer } from '@unitrack/core'`); Node resolves those
// via npm workspace symlinks and each package's own package.json.exports.
// A browser has no bare-specifier resolution at all without an import
// map, so this server builds one from the exact same exports data Node's
// own resolver already reads — there is no second, hand-maintained
// source of truth for what resolves where.

import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const PORT = Number(process.env.PORT ?? 8080);

/** @type {Record<string, string>} */
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

/**
 * Walks node_modules/@unitrack/* (every workspace package is linked there
 * regardless of whether this app directly depends on it, so a
 * transitive-only dependency like @unitrack/media-delivery-web — pulled in
 * by @unitrack/engine-audio-queue — resolves correctly with zero
 * special-casing) and builds one import-map entry per package.json.exports
 * key: "." -> the bare package name, "./types" -> "<packageName>/types",
 * each pointing at this package's real served source file.
 * @returns {Promise<Record<string, string>>}
 */
async function buildImportMap() {
  const unitrackDir = path.join(REPO_ROOT, 'node_modules', '@unitrack');
  const entries = await readdir(unitrackDir, { withFileTypes: true });
  /** @type {Record<string, string>} */
  const imports = {};
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const pkgJsonPath = path.join(unitrackDir, entry.name, 'package.json');
    /** @type {{ name: string, exports?: Record<string, { import?: string }> }} */
    let pkg;
    try {
      pkg = JSON.parse(await readFile(pkgJsonPath, 'utf8'));
    } catch {
      continue; // not every entry need be a valid, exports-bearing package
    }
    for (const [exportKey, condition] of Object.entries(pkg.exports ?? {})) {
      if (!condition || !condition.import) continue;
      const specifier = exportKey === '.' ? pkg.name : `${pkg.name}/${exportKey.slice(2)}`;
      const target = `/node_modules/@unitrack/${entry.name}/${condition.import.replace(/^\.\//, '')}`;
      imports[specifier] = target;
    }
  }
  return imports;
}

/**
 * @param {string} filePath
 * @returns {Promise<Buffer | null>}
 */
async function safeReadFile(filePath) {
  try {
    return await readFile(filePath);
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (url.pathname === '/') {
    const template = await readFile(path.join(__dirname, 'index.template.html'), 'utf8');
    const importMap = await buildImportMap();
    const html = template.replace('%%IMPORT_MAP%%', JSON.stringify({ imports: importMap }, null, 2));
    res.writeHead(200, { 'Content-Type': MIME_TYPES['.html'] });
    res.end(html);
    return;
  }

  // Every browser requests this unconditionally on page load; answering
  // 204 instead of falling through to the generic 404 below keeps the
  // console clean without needing an actual icon asset.
  if (url.pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Serve this app's own files, or anything under the repo root (which
  // resolves the import map's target URLs above — node_modules/@unitrack/
  // <pkg> is a workspace symlink into packages/<tier>/<pkg>, so this also
  // transparently serves each package's real source file, never a copy).
  const relativePath = decodeURIComponent(url.pathname).replace(/^\//, '');
  const candidatePaths = [
    path.join(__dirname, relativePath),
    path.join(REPO_ROOT, relativePath),
  ];
  for (const candidate of candidatePaths) {
    const resolved = path.normalize(candidate);
    if (!resolved.startsWith(REPO_ROOT)) continue; // no path traversal above the repo root
    const body = await safeReadFile(resolved);
    if (body) {
      const ext = path.extname(resolved);
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] ?? 'application/octet-stream' });
      res.end(body);
      return;
    }
  }
  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, () => {
  console.log(`@unitrack/web-demo listening on http://localhost:${PORT}`);
});
