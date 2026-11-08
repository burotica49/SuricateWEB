// Page de statut publique (lecture seule, sans connexion).
//
// Adresse /status/<jeton> : le jeton aléatoire du site est le seul accès. Elle ne montre que la disponibilité, les pannes et
// les maintenances — jamais une alerte de sécurité, un détail technique ni un réglage.
import { getWatchByStatusToken } from '../db.js';
import { statusData, renderStatusPage, serverTz } from '../report.js';
import { REPORT_CSP, sendHtml } from '../http.js';
import { clamp } from '../util.js';

const NOT_FOUND_PAGE = '<!doctype html><meta charset="utf-8"><meta name="robots" content="noindex"><title>Page introuvable</title><p style="font:16px system-ui;margin:40px">Page introuvable.</p>';

/** `clientIp(req)` : adresse du visiteur, pour limiter le débit (120 requêtes par minute et par adresse). */
export function createStatusPageHandler({ clientIp }) {
  const hits = new Map();
  return async function serveStatusPage(req, res, token, query) {
    const ip = clientIp(req);
    const hit = hits.get(ip) || { n: 0, t: Date.now() };
    if (Date.now() - hit.t > 60e3) Object.assign(hit, { n: 0, t: Date.now() });
    hits.set(ip, hit);
    if (++hit.n > 120) {
      res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '60' });
      return res.end('Trop de requêtes');
    }
    const w = await getWatchByStatusToken(token);
    if (!w) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow', 'content-security-policy': REPORT_CSP });
      return res.end(NOT_FOUND_PAGE);
    }
    const tz = Math.round(clamp(query.get('tz'), -840, 840, serverTz()));
    sendHtml(res, renderStatusPage({ title: w.config.statusPage.title || w.name, host: new URL(w.url).hostname.replace(/^www\./, ''), data: await statusData(w, tz), tz }));
  };
}
