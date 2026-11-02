// Relevé des versions PHP / CMS. VigieWeb appelle le plugin du site (le plugin n'appelle jamais VigieWeb).
import { getWatch, getSettings, setCmsReport } from './db.js';
import { describeError } from './checker.js';
import { carrySince } from './cms-alerts.js';

const MAX_BODY = 1024 * 1024;
const MAX_ITEMS = 400;
const TIMEOUT_S = 20;
const RETRY_MS = 30 * 60 * 1000;

const running = new Set();

const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/;

export function cleanCmsPath(path) {
  const s = String(path ?? '').trim().replace(/^\/+|\/+$/g, '');
  if (!s) return '';
  if (s.includes('..') || /[^a-zA-Z0-9._/-]/.test(s)) return null;
  return s.slice(0, 120);
}

/** null si la config est acceptable, sinon un message pour l'utilisateur. */
export function cmsConfigError(cms) {
  if (!cms?.type) return null;
  if (cms.token && cms.token.length < 16) return 'Le jeton doit contenir au moins 16 caractères';
  if (cleanCmsPath(cms.path) === null) return 'Le chemin du CMS est invalide';
  return null;
}

/** Adresse appelée : toujours l'origine du site + un chemin fixe. Jamais une URL libre. */
export function cmsEndpoint(pageUrl, cms) {
  if (cms?.type !== 'wordpress' && cms?.type !== 'prestashop') return null;
  let url;
  try {
    url = new URL(pageUrl);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return null;
  const prefix = cleanCmsPath(cms.path);
  if (prefix === null) return null;
  const base = prefix ? `/${prefix}` : '';
  if (cms.type === 'wordpress') {
    // Fonctionne avec ou sans permaliens réécrits.
    url.pathname = `${base}/`.replace(/\/{2,}/g, '/');
    url.search = 'rest_route=/vigieweb/v1/status';
  } else {
    url.pathname = `${base}/modules/vigieweb/status.php`.replace(/\/{2,}/g, '/');
    url.search = '';
  }
  url.hash = '';
  return url.href;
}

const versionOf = (v) => {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  return VERSION.test(s) ? s : null;
};

const labelOf = (v) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 120);

function itemList(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const it of arr) {
    if (!it || typeof it !== 'object' || out.length >= MAX_ITEMS) break;
    const name = labelOf(it.name) || labelOf(it.slug);
    const current = versionOf(it.current);
    if (!name && !current) continue;
    out.push({
      name: name || '—',
      slug: labelOf(it.slug).slice(0, 80),
      current,
      available: versionOf(it.available),
      active: !!it.active,
      known: it.known !== false,
    });
  }
  return out;
}

/** Réponse du plugin, bornée. Lève si le JSON n'est pas un relevé du CMS attendu. */
export function parseCmsReport(body, expectedType) {
  const data = typeof body === 'string' ? JSON.parse(body) : body;
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Réponse invalide');
  if (data.cms !== expectedType) throw new Error('Réponse invalide');
  const core = data.core && typeof data.core === 'object' ? data.core : {};
  return {
    php: versionOf(data.php),
    cms: expectedType,
    cmsVersion: versionOf(data.cmsVersion),
    core: {
      current: versionOf(core.current) || versionOf(data.cmsVersion),
      available: versionOf(core.available),
      known: core.known !== false,
    },
    extensions: itemList(data.extensions),
    themes: itemList(data.themes),
  };
}

async function readLimited(res) {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BODY) {
      await reader.cancel().catch(() => {});
      throw Object.assign(new Error('Réponse trop volumineuse'), { code: 'BODY_TOO_LARGE' });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function fetchReport(target, token, refresh) {
  const started = new URL(target);
  let cur = target;
  for (let hop = 0; hop <= 4; hop++) {
    const headers = {
      authorization: `Bearer ${token}`,
      'x-vigie-token': token,
      accept: 'application/json',
      'user-agent': getSettings().userAgent,
    };
    if (refresh) headers['x-vigie-refresh'] = '1';
    const res = await fetch(cur, { redirect: 'manual', headers, signal: AbortSignal.timeout(TIMEOUT_S * 1000) });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      await res.body?.cancel().catch(() => {});
      const next = new URL(loc, cur);
      if (!sameSite(started, next)) throw new Error('Redirection vers un autre domaine refusée');
      if (!/^https?:$/.test(next.protocol)) throw new Error('Redirection refusée');
      cur = next.href;
      continue;
    }
    const buf = await readLimited(res);
    const text = buf.toString('utf8');
    if (res.status === 401 || res.status === 403) throw new Error('Le plugin a refusé le jeton');
    if (res.status === 404) throw new Error('Plugin introuvable à cette adresse. Vérifiez qu’il est installé et activé, et le chemin si le site n’est pas à la racine.');
    if (res.status < 200 || res.status >= 300) throw new Error(`Le plugin a répondu HTTP ${res.status}`);
    return text;
  }
  throw new Error('Trop de redirections');
}

/** Même nom d'hôte. Le passage http ↔ https n'est accepté que sur les ports par défaut. */
function sameSite(from, to) {
  if (from.hostname !== to.hostname) return false;
  const port = (u) => u.port || (u.protocol === 'https:' ? '443' : '80');
  if (port(from) === port(to)) return true;
  return ['80', '443'].includes(port(from)) && ['80', '443'].includes(port(to));
}

/**
 * Interroge le plugin et enregistre le relevé dans state.cms.
 * Un échec conserve le dernier relevé réussi et indique l'erreur.
 * @returns {{ ok: boolean, error: string|null, cms: object|null }}
 */
export async function pollCms(id, { refresh = false } = {}) {
  if (process.env.VIGIE_DEMO === '1') return { ok: false, error: 'Mode démo : les contrôles sont désactivés (données fictives).', cms: null };
  if (running.has(id)) return { ok: false, error: 'Relevé déjà en cours', cms: null };
  const w = getWatch(id);
  if (!w) return { ok: false, error: 'Site introuvable', cms: null };
  const cms = w.config.cms;
  if (w.config.mode === 'domain' || (cms.type !== 'wordpress' && cms.type !== 'prestashop')) {
    return { ok: false, error: 'Aucun CMS configuré pour ce site', cms: null };
  }
  running.add(id);
  const interval = cms.intervalMin * 60 * 1000;
  let error = null;
  let report = null;
  try {
    if (!cms.token) throw new Error('Jeton manquant : copiez-le dans le plugin.');
    const target = cmsEndpoint(w.url, cms);
    if (!target) throw new Error('Adresse du site invalide pour le relevé CMS');
    const text = await fetchReport(target, cms.token, refresh);
    report = parseCmsReport(text, cms.type);
  } catch (e) {
    if (e instanceof SyntaxError) error = 'Réponse invalide';
    else error = describeError(e).message || 'Relevé impossible';
  } finally {
    running.delete(id);
  }
  const current = getWatch(id);
  if (!current) return { ok: !error, error, cms: report };
  const prev = current.state.cms && typeof current.state.cms === 'object' ? current.state.cms : {};
  const saved = report
    ? { ...carrySince(prev, report, Date.now()), checkedAt: Date.now(), ok: true, error: null }
    : { ...prev, checkedAt: Date.now(), ok: false, error };
  const nextCms = Date.now() + (report ? interval : Math.min(interval, RETRY_MS));
  setCmsReport(id, saved, nextCms);
  return { ok: !!report, error, cms: saved };
}
