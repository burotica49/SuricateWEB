// Fichiers de l'interface (dossier public/), servis avec des en-têtes de sécurité stricts.
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { send } from '../http.js';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

export function createStaticHandler(publicDir) {
  return async function serveStatic(req, res, pathname) {
    let rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
    if (!rel || rel.endsWith('/')) rel += 'index.html';
    const file = join(publicDir, rel);
    if (!file.startsWith(publicDir)) return send(res, 403, { error: 'Interdit' });
    try {
      const st = await stat(file);
      if (!st.isFile()) throw new Error();
      const buf = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[extname(file)] || 'application/octet-stream',
        'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
      });
      res.end(buf);
    } catch {
      send(res, 404, { error: 'Introuvable' });
    }
  };
}
