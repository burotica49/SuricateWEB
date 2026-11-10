// Relevé des versions PHP / CMS. SuricateWeb appelle le plugin du site (le plugin n'appelle jamais SuricateWeb).
import { getWatch, settingsFor, setCmsReport, updateWatch, wakeWatch } from './db.js';
import { describeError } from './checker.js';
import { getExtensions } from './extensions.js';
import { carrySince, carryAdmins, carryHistory, acceptAdmins, carryCode, acceptCode, codeAlertFiles } from './cms-alerts.js';

const MAX_BODY = 1024 * 1024;
const MAX_ITEMS = 400;
const TIMEOUT_S = 20;
/** Le contrôle d'intégrité lit tous les fichiers du site : il peut être long sur un hébergement lent. */
const INTEGRITY_TIMEOUT_S = 90;
/** Le plugin s'arrête de lui-même à 45 s (et reprend au relevé suivant) : on lui laisse un peu plus pour répondre. */
const CODE_TIMEOUT_S = 90;
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

/**
 * Adresse appelée : toujours l'origine du site + un chemin fixe. Jamais une URL libre.
 * `scope` : « status » (versions, administrateurs), « integrity » (sommes de contrôle des fichiers) ou « code » (recherche de code suspect).
 */
export function cmsEndpoint(pageUrl, cms, scope = 'status') {
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
    url.search = `rest_route=/suricateweb/v1/${['integrity', 'code'].includes(scope) ? scope : 'status'}`;
  } else {
    url.pathname = `${base}/modules/suricateweb/status.php`.replace(/\/{2,}/g, '/');
    url.search = ['integrity', 'code'].includes(scope) ? `scope=${scope}` : '';
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

const count = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.min(Math.floor(Number(v)), 1e6) : null);

/** Comptes administrateurs : un compteur et les créations récentes (identifiant, nom de connexion, date). */
function parseAdmins(a) {
  if (!a || typeof a !== 'object') return null;
  const total = count(a.count);
  if (total == null) return null;
  const recent = [];
  for (const r of Array.isArray(a.recent) ? a.recent : []) {
    if (!r || typeof r !== 'object' || recent.length >= 50) continue;
    const id = count(r.id);
    if (id == null) continue;
    const registered = Date.parse(r.registered);
    recent.push({ id, login: labelOf(r.login).slice(0, 60), registered: Number.isFinite(registered) ? registered : null });
  }
  return { count: total, windowDays: count(a.windowDays) ?? 0, recent };
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
    admins: parseAdmins(data.admins),
  };
}

const pathOf = (v) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 200);
const pathList = (arr) => (Array.isArray(arr) ? arr.map(pathOf).filter(Boolean).slice(0, 50) : []);

function integritySection(sec) {
  const o = sec && typeof sec === 'object' ? sec : {};
  return { known: o.known === true, checked: count(o.checked) ?? 0, modified: pathList(o.modified), added: pathList(o.added), missing: pathList(o.missing), more: count(o.more) ?? 0 };
}

/** Réponse de la route d'intégrité, bornée. Un plugin trop ancien répond sans la section « integrity ». */
export function parseIntegrityReport(body, expectedType) {
  const data = typeof body === 'string' ? JSON.parse(body) : body;
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.cms !== expectedType) throw new Error('Réponse invalide');
  const i = data.integrity;
  if (!i || typeof i !== 'object') throw Object.assign(new Error(`${expectedType === 'prestashop' ? 'Module' : 'Plugin'} trop ancien : mettez-le à jour pour contrôler l'intégrité des fichiers.`), { code: 'PLUGIN_OLD' });
  const up = i.uploads && typeof i.uploads === 'object' ? i.uploads : {};
  const plugins = [];
  for (const p of Array.isArray(i.plugins) ? i.plugins : []) {
    if (!p || typeof p !== 'object' || plugins.length >= 150) continue;
    plugins.push({
      name: labelOf(p.name) || labelOf(p.slug) || '—', slug: labelOf(p.slug).slice(0, 80), version: versionOf(p.version),
      ...integritySection(p), skipped: p.skipped === true,
    });
  }
  return {
    core: { ...integritySection(i.core), version: versionOf(i.core?.version) },
    plugins,
    uploads: { php: pathList(up.php), more: count(up.more) ?? 0, scanned: count(up.scanned) ?? 0, truncated: up.truncated === true },
    dirs: Array.isArray(i.dirs) ? i.dirs.map(pathOf).filter(Boolean).slice(0, 10) : [],
    partial: i.partial === true,
  };
}

const CODE_LEVELS = new Set(['strong', 'review', 'vendor']);
const HIT_ID = /^[a-z_]{1,40}$/;
const SHORT_HASH = /^[0-9a-f]{6,16}$/;

/**
 * Réponse de la route « code », bornée. Le plugin n'envoie JAMAIS le contenu d'un fichier : un chemin, des identifiants de motifs
 * (liste fermée côté plugin) et une empreinte courte. Tout le reste est écarté ici, quoi que le site réponde.
 * `{ enabled: false }` : l'analyse est coupée côté site (en-tête de désactivation).
 */
export function parseCodeReport(body, expectedType) {
  const data = typeof body === 'string' ? JSON.parse(body) : body;
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.cms !== expectedType) throw new Error('Réponse invalide');
  const c = data.code;
  if (!c || typeof c !== 'object') throw Object.assign(new Error(`${expectedType === 'prestashop' ? 'Module' : 'Plugin'} trop ancien : mettez-le à jour (version 1.3 ou plus) pour rechercher le code suspect.`), { code: 'PLUGIN_OLD' });
  if (c.enabled === false) return { enabled: false };
  const files = [];
  for (const f of Array.isArray(c.files) ? c.files : []) {
    if (!f || typeof f !== 'object' || files.length >= 60) continue;
    const path = pathOf(f.path);
    if (!path || !CODE_LEVELS.has(f.level)) continue;
    files.push({
      path,
      level: f.level,
      hits: (Array.isArray(f.hits) ? f.hits : []).map((h) => String(h)).filter((h) => HIT_ID.test(h)).slice(0, 12),
      hash: SHORT_HASH.test(String(f.hash)) ? String(f.hash) : '',
      origin: f.origin === 'change' ? 'change' : 'baseline',
    });
  }
  const d = c.drift && typeof c.drift === 'object' ? c.drift : {};
  return {
    enabled: true,
    files,
    more: count(c.more) ?? 0,
    drift: { files: pathList(d.files), more: count(d.more) ?? 0, days: count(d.days) ?? 14 },
    inventory: count(c.inventory) ?? 0,
    baseline: c.baseline === true,
    partial: c.partial === true,
    // Sans stockage inscriptible côté site, chaque relevé repart de zéro : aucun « changement » ne peut être constaté.
    persistent: c.persistent !== false,
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

async function fetchReport(target, token, refresh, { timeoutS = TIMEOUT_S, notFound, userAgent } = {}) {
  const started = new URL(target);
  let cur = target;
  for (let hop = 0; hop <= 4; hop++) {
    const headers = {
      authorization: `Bearer ${token}`,
      'x-suricate-token': token,
      accept: 'application/json',
      'user-agent': userAgent,
    };
    if (refresh) headers['x-suricate-refresh'] = '1';
    const res = await getExtensions().netGuard.fetch(cur, { redirect: 'manual', headers, signal: AbortSignal.timeout(timeoutS * 1000) });
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
    if (res.status === 404 && notFound) throw new Error(notFound);
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
  if (process.env.SURICATE_DEMO === '1') return { ok: false, error: 'Mode démo : les contrôles sont désactivés (données fictives).', cms: null };
  if (running.has(id)) return { ok: false, error: 'Relevé déjà en cours', cms: null };
  const w = await getWatch(id);
  if (!w) return { ok: false, error: 'Site introuvable', cms: null };
  const cms = w.config.cms;
  if (w.config.mode === 'domain' || (cms.type !== 'wordpress' && cms.type !== 'prestashop')) {
    return { ok: false, error: 'Aucun CMS configuré pour ce site', cms: null };
  }
  running.add(id);
  const interval = cms.intervalMin * 60 * 1000;
  let error = null;
  let report = null;
  let integrity = null;
  let integrityError = null;
  let code = null;
  let codeError = null;
  try {
    if (!cms.token) throw new Error('Jeton manquant : copiez-le dans le plugin.');
    const target = cmsEndpoint(w.url, cms);
    if (!target) throw new Error('Adresse du site invalide pour le relevé CMS');
    const { userAgent } = await settingsFor(w.accountId); // le User-Agent du compte propriétaire du site
    const text = await fetchReport(target, cms.token, refresh, { userAgent });
    report = parseCmsReport(text, cms.type);
    if (cms.security !== false) {
      // Relevé séparé : un plugin sans cette route (ancienne version) ne doit pas faire échouer le relevé des versions.
      try {
        const sum = await fetchReport(cmsEndpoint(w.url, cms, 'integrity'), cms.token, refresh, {
          timeoutS: INTEGRITY_TIMEOUT_S,
          userAgent,
          notFound: `${cms.type === 'prestashop' ? 'Module' : 'Plugin'} trop ancien : mettez-le à jour pour contrôler l'intégrité des fichiers.`,
        });
        integrity = parseIntegrityReport(sum, cms.type);
      } catch (e) {
        integrityError = e instanceof SyntaxError ? 'Réponse invalide' : describeError(e).message || 'Contrôle d’intégrité impossible';
      }
      if (cms.codeScan !== false) {
        // Troisième relevé, lui aussi isolé : un plugin sans cette route (avant 1.3) garde ses versions et son intégrité.
        try {
          const txt = await fetchReport(cmsEndpoint(w.url, cms, 'code'), cms.token, refresh, {
            timeoutS: CODE_TIMEOUT_S,
            userAgent,
            notFound: `${cms.type === 'prestashop' ? 'Module' : 'Plugin'} trop ancien : mettez-le à jour (version 1.3 ou plus) pour rechercher le code suspect.`,
          });
          code = parseCodeReport(txt, cms.type);
        } catch (e) {
          codeError = e instanceof SyntaxError ? 'Réponse invalide' : describeError(e).message || 'Recherche de code suspect impossible';
        }
      }
    }
  } catch (e) {
    if (e instanceof SyntaxError) error = 'Réponse invalide';
    else error = describeError(e).message || 'Relevé impossible';
  } finally {
    running.delete(id);
  }
  const current = await getWatch(id);
  if (!current) return { ok: !error, error, cms: report };
  const prev = current.state.cms && typeof current.state.cms === 'object' ? current.state.cms : {};
  const now = Date.now();
  if (report) {
    carrySince(prev, report, now);
    carryHistory(prev, report, now);
    carryAdmins(prev, report, now);
    if (cms.security !== false) {
      // Un contrôle d'intégrité qui échoue garde le dernier résultat réussi, avec l'erreur : pas de « tout va bien » inventé.
      if (integrity) report.integrity = { ...integrity, checkedAt: now, ok: true, error: null };
      else report.integrity = { ...(prev.integrity || {}), ok: false, error: integrityError, ...(prev.integrity?.checkedAt ? {} : { checkedAt: now }) };
      if (cms.codeScan !== false) {
        // Même règle que l'intégrité : une erreur garde le dernier résultat réussi (et ses acquittements), jamais un « tout va bien » inventé.
        if (code?.enabled) report.code = carryCode(prev.code, { ...code, checkedAt: now, ok: true, error: null }, now);
        else if (code) report.code = { enabled: false, checkedAt: now, ok: true, error: null }; // coupé côté site
        else if (prev.code) report.code = { ...prev.code, ok: false, error: codeError, ...(prev.code.checkedAt ? {} : { checkedAt: now }) };
        else report.code = { enabled: true, files: [], more: 0, drift: { files: [], more: 0, days: 14 }, inventory: 0, baseline: false, partial: false, persistent: true, acks: [], ok: false, error: codeError, checkedAt: now };
      }
    }
  }
  const saved = report
    ? { ...report, checkedAt: now, ok: true, error: null }
    : { ...prev, checkedAt: now, ok: false, error };
  const nextCms = now + (report ? interval : Math.min(interval, RETRY_MS));
  await setCmsReport(id, saved, nextCms);
  // Les incidents (mises à jour, intégrité, administrateurs) sont évalués par le contrôle du site : on le lance sans attendre.
  if (report) await wakeWatch(id);
  return { ok: !!report, error, cms: saved };
}

/** « Je connais ces comptes » : l'état actuel des administrateurs devient la référence, l'incident disparaît sans message « rétabli ». */
export async function acceptCmsAdmins(id) {
  const w = await getWatch(id);
  const admins = w?.state.cms?.admins;
  if (!admins) return null;
  const state = { ...w.state, cms: { ...w.state.cms, admins: acceptAdmins(admins) } };
  if (state.incidents?.cms_admins) {
    state.incidents = { ...state.incidents };
    delete state.incidents.cms_admins;
  }
  return await updateWatch(id, { state });
}

/**
 * « Je connais ce fichier » : le fichier (chemin + empreinte) est reconnu ; sans chemin, tous les fichiers actuellement signalés.
 * Une nouvelle modification du fichier change son empreinte : il redevient une alerte.
 */
export async function acceptCmsCode(id, path = '') {
  const w = await getWatch(id);
  const code = w?.state.cms?.code;
  if (!code?.files) return null;
  const next = acceptCode(code, path);
  if (!next) return null;
  const state = { ...w.state, cms: { ...w.state.cms, code: next } };
  // L'incident est reconstruit au prochain contrôle ; s'il ne reste plus rien à signaler, on le retire tout de suite, sans message « rétabli ».
  if (state.incidents?.cms_integrity_code && !codeAlertFiles(next).length) {
    state.incidents = { ...state.incidents };
    delete state.incidents.cms_integrity_code;
  }
  return await updateWatch(id, { state });
}
