// VigieWeb — serveur HTTP + API. Aucune dépendance externe.
import './src/env.js'; // doit rester le 1er import : charge le .env avant l'ouverture de la base
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  db, getSettings, saveSettings, listWatches, getWatch, createWatch, updateWatch, deleteWatch,
  getSnapshot, previousSnapshot, snapshotLines, normalizeConfig, defaultConfig, DEFAULT_KEYWORDS,
  uptimeBetween, uptimeSummary, uptimeBars, outageList, responseStats, responseSeries, closeOutage, DAY_MS, UPTIME_PERIODS,
  getScreenshot, listScreenshots, latestScreenshots, SHOTS_DIR,
  listGroups, getGroup, createGroup, updateGroup, deleteGroup, applyLayout, GroupError,
} from './src/db.js';
import { enqueue, isRunning, startScheduler } from './src/scheduler.js';
import { cmsConfigError, pollCms } from './src/cms.js';
import { zipDirectory } from './src/zip.js';
import { captureWatch, isCapturing, engine, chromePath, removeWatchShots, NO_CHROME } from './src/screenshot.js';
import { fetchPage, analyze, describeError } from './src/checker.js';
import { diffLines, collapse } from './src/diff.js';
import * as tg from './src/telegram.js';
import { bus } from './src/events.js';
import { clamp, registrable, SEV } from './src/util.js';
import { readCredentials, checkLogin, sessionKey } from './src/auth.js';

// L'application ne démarre pas sans identifiants : pas de fenêtre où elle serait ouverte à tous.
const CREDS = readCredentials();
if (CREDS.error) {
  console.error(CREDS.error);
  process.exit(1);
}

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, 'public');

// Version et liens affichés dans la barre latérale : package.json est la source unique (rien à mettre à jour ailleurs).
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const webUrl = (u) => {
  const clean = String(u ?? '').replace(/^git\+/, '').replace(/\.git$/, '');
  return /^https?:\/\//.test(clean) ? clean : null; // seul http(s) : jamais de « javascript: » dans un lien
};
const APP_INFO = (() => {
  const repoUrl = webUrl(PKG.repository?.url ?? PKG.repository);
  return { version: String(PKG.version ?? ''), repoUrl, docsUrl: webUrl(PKG.homepage) ?? (repoUrl ? `${repoUrl}#readme` : null) };
})();
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ───────────── Authentification (obligatoire, identifiants lus dans .env) ─────────────

const SESSION_DAYS = 30;
const sign = (v) => createHmac('sha256', sessionKey(CREDS, getSettings().sessionSecret)).update(v).digest('hex');

function makeSession() {
  const exp = String(Date.now() + SESSION_DAYS * 864e5);
  return `${exp}.${sign(exp)}`;
}

function validSession(req) {
  const m = /(?:^|;\s*)vigie_session=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(exp));
  return a.length === b.length && timingSafeEqual(a, b);
}

// Derrière un reverse proxy (Dokploy/Traefik, nginx…) : TRUST_PROXY=1 active la lecture de X-Forwarded-*.
const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY || '');
const clientIp = (req) => (TRUST_PROXY && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress;
const sessionCookie = (req, value, maxAge) =>
  `vigie_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`;
const attempts = new Map();

// ───────────── Routeur ─────────────

const routes = [];
const route = (method, path, handler, opts = {}) => {
  const keys = [];
  const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$');
  routes.push({ method, re, keys, handler, ...opts });
};

const send = (res, status, data, headers = {}) => {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(body);
};

async function readJson(req) {
  const chunks = [];
  let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > 2e6) throw new HttpError(413, 'Requête trop volumineuse');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON invalide');
  }
}

// ───────────── Helpers métier ─────────────

function normalizeUrl(input) {
  let u = String(input || '').trim();
  if (!u) throw new HttpError(400, "L'adresse du site est obligatoire");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = 'https://' + u;
  let url;
  try {
    url = new URL(u);
  } catch {
    throw new HttpError(400, 'Adresse invalide');
  }
  if (!/^https?:$/.test(url.protocol)) throw new HttpError(400, 'Seules les adresses http:// et https:// sont acceptées');
  return url.href;
}

function validateConfig(cfg) {
  const cmsErr = cmsConfigError(cfg.cms);
  if (cmsErr) throw new HttpError(400, cmsErr);
  for (const r of cfg.ignoreRegex) {
    try {
      new RegExp(r, 'i');
    } catch {
      throw new HttpError(400, `Expression régulière invalide : ${r}`);
    }
  }
}

const SELECTOR_CHECK = async (cfg) => {
  const { parseHtml, selectAll } = await import('./src/html.js');
  const dummy = parseHtml('<div></div>');
  for (const s of [cfg.selector, cfg.excludeSelector].filter(Boolean)) {
    try {
      selectAll(dummy, s);
    } catch (e) {
      throw new HttpError(400, e.message);
    }
  }
};

const RESET_KEYS = ['selector', 'excludeSelector', 'ignoreRegex', 'images'];

/** Même échéance, à deux jours près : un renouvellement (souvent +1 an) ne correspond pas. */
const sameExpiry = (a, b) => (a == null || b == null ? a == null && b == null : Math.abs(a - b) < 2 * 864e5);

/**
 * Le rappel « le domaine expire bientôt » quitte l'accueil une fois acquitté,
 * tant que l'échéance est la même et qu'elle n'est pas devenue plus grave (30 j → moins de 7).
 * La date reste dans le détail du site.
 */
function domainExpiryAcked(w, ctx) {
  const cur = w.state.incidents?.rdap_expiring;
  if (!cur) return false;
  const rank = SEV[cur.severity] || 0;
  const expires = w.state.rdap?.expires ?? null;
  const stored = w.state.domainAck?.rdap_expiring;
  if (stored && rank <= (SEV[stored.severity] || 0) && sameExpiry(stored.expires ?? null, expires)) return true;
  const seen = ctx.domainExpiry?.get(w.id);
  return !!(seen && !seen.unread && rank <= seen.max);
}

/** Mémorise l'acquittement sur le site : il survit aux contrôles suivants, même sans alerte non lue. */
function rememberDomainAck(id) {
  const w = getWatch(id);
  const inc = w?.state.incidents?.rdap_expiring;
  if (!inc) return;
  updateWatch(id, {
    state: { ...w.state, domainAck: { ...(w.state.domainAck || {}), rdap_expiring: { severity: inc.severity, expires: w.state.rdap?.expires ?? null } } },
  });
}

function summarize(w, ctx) {
  const quietDomain = domainExpiryAcked(w, ctx);
  const incidents = Object.entries(w.state.incidents || {}).map(([key, i]) => ({ key, ...i, ...(key === 'rdap_expiring' && quietDomain ? { acked: true } : {}) }));
  const open = incidents.filter((i) => !i.acked);
  const unread = ctx.unread[w.id] || { critical: 0, warning: 0, info: 0 };
  let status = 'ok';
  if (!w.enabled) status = 'paused';
  else if (!w.lastCheck) status = 'pending';
  else if (open.some((i) => i.severity === 'critical') || unread.critical) status = 'critical';
  else if (open.some((i) => i.severity === 'warning') || unread.warning) status = 'warning';
  if (status === 'critical' && w.state.incidents?.down) status = 'down';
  const stats = ctx.stats[w.id] || {};
  const now = Date.now();
  const domainOnly = w.config.mode === 'domain';
  return {
    id: w.id, name: w.name, url: w.url, interval: w.interval, enabled: w.enabled, tags: w.tags, mode: w.config.mode,
    shot: ctx.shots?.[w.id] || null, shotError: w.shotError || null, groupId: w.groupId, position: w.position,
    status, running: isRunning(w.id),
    lastCheck: w.lastCheck, nextRun: w.enabled ? w.nextRun : null, lastCode: w.lastCode, lastMs: w.lastMs, lastError: w.lastError,
    title: w.state.title || '', finalUrl: w.state.finalUrl || '',
    incidents,
    unread, avgMs: stats.avgMs ?? null, spark: stats.spark || [],
    uptime: domainOnly ? null : uptimeBetween(w, now - DAY_MS, now, now).uptime,
    uptime30: domainOnly ? null : uptimeBetween(w, now - 30 * DAY_MS, now, now).uptime,
    tlsExpires: w.state.tls?.expires || null, domainExpires: w.state.rdap?.expires || null,
  };
}

function buildCtx() {
  const unread = {};
  for (const r of db.prepare("SELECT watch_id, severity, COUNT(*) n FROM alerts WHERE read = 0 AND severity IN ('critical','warning','info') GROUP BY watch_id, severity").all()) {
    (unread[r.watch_id] ||= { critical: 0, warning: 0, info: 0 })[r.severity] = r.n;
  }
  // Dernière alerte d'échéance déjà émise : sert à la retirer de l'accueil une fois lue.
  const domainExpiry = new Map();
  for (const r of db.prepare(`
    SELECT watch_id, MIN(read) = 0 AS unread,
           MAX(CASE severity WHEN 'critical' THEN 3 WHEN 'warning' THEN 2 WHEN 'info' THEN 1 ELSE 0 END) AS max
    FROM alerts WHERE type = 'rdap_expiring' GROUP BY watch_id
  `).all()) domainExpiry.set(r.watch_id, { unread: !!r.unread, max: r.max });
  const stats = {};
  const since = Date.now() - 864e5;
  for (const r of db.prepare('SELECT watch_id, COUNT(*) n, SUM(ok) ok, AVG(CASE WHEN ok = 1 THEN ms END) avg FROM checks WHERE ts > ? GROUP BY watch_id').all(since)) {
    stats[r.watch_id] = { uptime: r.n ? Math.round((r.ok / r.n) * 1000) / 10 : null, avgMs: r.avg ? Math.round(r.avg) : null };
  }
  const spark = db.prepare('SELECT ms, ok FROM checks WHERE watch_id = ? ORDER BY id DESC LIMIT 40');
  for (const w of db.prepare('SELECT id FROM watches').all()) {
    (stats[w.id] ||= {}).spark = spark.all(w.id).reverse().map((r) => (r.ok ? r.ms : null));
  }
  return { unread, stats, shots: latestScreenshots(), domainExpiry };
}

const alertRow = (r) => ({
  id: r.id, watchId: r.watch_id, watchName: r.watch_name, ts: r.ts, severity: r.severity, type: r.type, title: r.title,
  detail: r.detail, snapshotId: r.snapshot_id, prevSnapshotId: r.prev_snapshot_id, read: !!r.read, notified: !!r.notified, notifyError: r.notify_error,
});

const maskToken = (t) => (t ? t.slice(0, 4) + '••••••••' + t.slice(-4) : '');

function publicSettings() {
  const s = getSettings();
  return {
    telegram: { ...s.telegram, token: '', tokenSet: !!s.telegram.token, tokenMasked: maskToken(s.telegram.token) },
    baseUrl: s.baseUrl, defaultInterval: s.defaultInterval, userAgent: s.userAgent, builtinKeywords: s.builtinKeywords,
    retention: s.retention, authUser: CREDS.user, defaultKeywords: DEFAULT_KEYWORDS,
    screenshots: { available: engine.available(), browser: chromePath() },
    app: APP_INFO,
  };
}

function watchInput(body, existing) {
  const s = getSettings();
  const cfg = normalizeConfig({ ...(existing?.config || defaultConfig()), ...(body.config || {}), checks: { ...(existing?.config.checks || {}), ...(body.config?.checks || {}) } });
  if (cfg.cms.type && !cfg.cms.token) cfg.cms.token = randomBytes(32).toString('base64url');
  validateConfig(cfg);
  const url = body.url !== undefined ? normalizeUrl(body.url) : existing.url;
  const tags = Array.isArray(body.tags) ? [...new Set(body.tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 10) : existing?.tags || [];
  // Groupe : absent = inchangé ; null / '' = « Sans groupe » ; sinon il doit exister.
  let groupId = existing?.groupId ?? null;
  if (body.groupId !== undefined) {
    if (body.groupId === null || body.groupId === '') groupId = null;
    else if (getGroup(Number(body.groupId))) groupId = Number(body.groupId);
    else throw new HttpError(400, 'Groupe inconnu');
  }
  return {
    cfg,
    data: {
      groupId,
      url,
      name: String(body.name ?? existing?.name ?? '').trim() || new URL(url).hostname.replace(/^www\./, ''),
      interval: clamp(body.interval ?? existing?.interval ?? s.defaultInterval, 1, 10080, 15),
      tags,
      enabled: body.enabled !== undefined ? !!body.enabled : existing?.enabled ?? true,
      config: cfg,
    },
  };
}

// ───────────── Routes : auth ─────────────

route('GET', '/api/auth', (ctx) => ({ required: true, authenticated: validSession(ctx.req) }), { public: true });

route('POST', '/api/login', (ctx) => {
  const ip = clientIp(ctx.req);
  const a = attempts.get(ip) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 60e3) Object.assign(a, { n: 0, t: Date.now() });
  if (a.n >= 5) throw new HttpError(429, 'Trop de tentatives, réessayez dans une minute');
  a.n++;
  attempts.set(ip, a);
  if (!checkLogin(CREDS, ctx.body.username, String(ctx.body.password ?? ''))) throw new HttpError(401, 'Identifiant ou mot de passe incorrect');
  attempts.delete(ip);
  ctx.headers['set-cookie'] = sessionCookie(ctx.req, makeSession(), SESSION_DAYS * 86400);
  return { ok: true };
}, { public: true });

route('POST', '/api/logout', (ctx) => {
  ctx.headers['set-cookie'] = sessionCookie(ctx.req, '', 0);
  return { ok: true };
}, { public: true });

// ───────────── Routes : tableau de bord / sites ─────────────

route('GET', '/api/watches', () => {
  const ctx = buildCtx();
  return listWatches().map((w) => summarize(w, ctx));
});

route('POST', '/api/watches', async (ctx) => {
  const { data, cfg } = watchInput(ctx.body);
  await SELECTOR_CHECK(cfg);
  let w = createWatch(data);
  if (w.config.cms.type) w = updateWatch(w.id, { nextCms: Date.now() });
  enqueue(w.id);
  return summarize(w, buildCtx());
});

route('GET', '/api/watches/:id', (ctx) => {
  const w = getWatch(Number(ctx.params.id));
  if (!w) throw new HttpError(404, 'Site introuvable');
  const checks = db.prepare('SELECT id, ts, ok, code, ms, size, error, alerts FROM checks WHERE watch_id = ? ORDER BY id DESC LIMIT 200').all(w.id).reverse();
  const { state } = w;
  return {
    ...summarize(w, buildCtx()),
    config: w.config,
    createdAt: w.createdAt,
    checks,
    signals: {
      dns: state.dns || null, resolvers: state.resolvers || {}, tls: state.tls || null, rdap: state.rdap?.unsupported ? { unsupported: true } : state.rdap || null,
      server: state.server || '', scripts: state.scripts?.length ?? null, linkHosts: state.linkHosts?.length ?? null,
      baseline: !!state.baseline,
    },
    cms: state.cms || null,
  };
});

route('PUT', '/api/watches/:id', async (ctx) => {
  const w = getWatch(Number(ctx.params.id));
  if (!w) throw new HttpError(404, 'Site introuvable');
  const { data, cfg } = watchInput(ctx.body, w);
  await SELECTOR_CHECK(cfg);
  const state = { ...w.state };
  if (data.url !== w.url || RESET_KEYS.some((k) => JSON.stringify(cfg[k]) !== JSON.stringify(w.config[k]))) state.baseline = false;
  // Nouvelle adresse ou réglages de capture modifiés : on recapture sans attendre l'échéance.
  const reshoot = data.url !== w.url || JSON.stringify(cfg.screenshot) !== JSON.stringify(w.config.screenshot);
  const cmsOn = cfg.mode !== 'domain' && !!cfg.cms.type;
  const cmsChanged = JSON.stringify(cfg.cms) !== JSON.stringify(w.config.cms) || data.url !== w.url;
  const nextCms = cmsOn ? (cmsChanged || !(w.nextCms > 0) ? Date.now() : w.nextCms) : 0;
  const u = updateWatch(w.id, { ...data, state, nextRun: data.enabled ? 0 : w.nextRun, ...(reshoot ? { nextShot: 0 } : {}), nextCms });
  return summarize(u, buildCtx());
});

route('DELETE', '/api/watches/:id', async (ctx) => {
  const id = Number(ctx.params.id);
  if (!deleteWatch(id)) throw new HttpError(404, 'Site introuvable');
  await removeWatchShots(id);
  return { ok: true };
});

// ───────────── Routes : groupes de sites ─────────────

const layoutChanged = () => bus.emit('event', { type: 'layout' });

route('GET', '/api/groups', () => listGroups());

route('POST', '/api/groups', (ctx) => {
  const g = createGroup(ctx.body);
  layoutChanged();
  return g;
});

route('PUT', '/api/groups/:id', (ctx) => {
  const g = updateGroup(Number(ctx.params.id), ctx.body);
  if (!g) throw new HttpError(404, 'Groupe introuvable');
  layoutChanged();
  return g;
});

// Les sites du groupe ne sont jamais supprimés : ils passent dans « Sans groupe ».
route('DELETE', '/api/groups/:id', (ctx) => {
  if (!deleteGroup(Number(ctx.params.id))) throw new HttpError(404, 'Groupe introuvable');
  layoutChanged();
  return { ok: true };
});

// Organisation complète issue d'un glisser-déposer, appliquée en une seule transaction.
route('PUT', '/api/layout', (ctx) => {
  applyLayout(ctx.body);
  layoutChanged();
  return { ok: true, groups: listGroups() };
});

// ───────────── Routes : captures d'écran ─────────────

route('GET', '/api/watches/:id/screenshots', (ctx) => {
  const w = loadWatch(ctx);
  return {
    available: engine.available(),
    enabled: w.config.screenshot.enabled && w.config.mode !== 'domain',
    interval: w.config.screenshot.interval,
    nextShot: w.nextShot,
    error: w.shotError,
    capturing: isCapturing(w.id),
    items: listScreenshots(w.id, clamp(ctx.query.get('limit'), 1, 500, 200)),
  };
});

route('POST', '/api/watches/:id/screenshot', async (ctx) => {
  const w = loadWatch(ctx);
  if (w.config.mode === 'domain') throw new HttpError(400, "Un domaine seul n'a pas de page à capturer");
  if (!engine.available()) throw new HttpError(503, NO_CHROME);
  const r = await captureWatch(w.id, { kind: 'manual' });
  if (r.error) throw new HttpError(502, `Capture impossible : ${r.error}`);
  return { id: r.id, ts: r.ts };
});

// L'image passe par l'API pour rester derrière la connexion : un lien de capture n'est jamais public.
route('GET', '/api/screenshots/:id/image', async (ctx) => {
  const s = getScreenshot(Number(ctx.params.id));
  if (!s) throw new HttpError(404, 'Capture introuvable (supprimée par la rétention ?)');
  const buf = await readFile(join(SHOTS_DIR, ctx.query.get('thumb') && s.thumb ? s.thumb : s.file)).catch(() => null);
  if (!buf) throw new HttpError(404, 'Fichier de capture introuvable');
  ctx.res.writeHead(200, {
    'content-type': 'image/jpeg', 'content-length': buf.length, 'x-content-type-options': 'nosniff',
    'cache-control': 'private, max-age=31536000, immutable', // l'identifiant d'une capture ne change jamais de contenu
  });
  ctx.res.end(buf);
  return Symbol.for('handled');
});

route('GET', '/api/plugins/:file', (ctx) => {
  const dir = { 'wordpress.zip': 'wordpress', 'prestashop.zip': 'prestashop' }[ctx.params.file];
  if (!dir) throw new HttpError(404, 'Plugin introuvable');
  const buf = zipDirectory(join(ROOT, 'plugins', dir, 'vigieweb'), 'vigieweb');
  ctx.res.writeHead(200, {
    'content-type': 'application/zip',
    'content-disposition': `attachment; filename="vigieweb-${dir}.zip"`,
    'content-length': String(buf.length),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  ctx.res.end(buf);
  return Symbol.for('handled');
});

route('POST', '/api/watches/:id/cms', async (ctx) => {
  const w = getWatch(Number(ctx.params.id));
  if (!w) throw new HttpError(404, 'Site introuvable');
  if (w.config.mode === 'domain' || !w.config.cms.type) throw new HttpError(400, 'Aucun CMS configuré pour ce site');
  return pollCms(w.id, { refresh: true });
});

route('POST', '/api/watches/:id/check', async (ctx) => {
  const id = Number(ctx.params.id);
  if (!getWatch(id)) throw new HttpError(404, 'Site introuvable');
  const r = await enqueue(id, { wait: true });
  return { ok: true, result: r && { code: r.code, ms: r.ms, error: r.error, alerts: r.alerts?.length || 0 } };
});

route('POST', '/api/watches/:id/toggle', (ctx) => {
  const w = getWatch(Number(ctx.params.id));
  if (!w) throw new HttpError(404, 'Site introuvable');
  // Mettre en pause clôt une panne en cours : le temps en pause ne doit pas compter comme indisponibilité.
  const state = { ...w.state };
  if (w.enabled && state.outageId) {
    closeOutage(state.outageId, Date.now());
    Object.assign(state, { outageId: null, failSince: null, fails: 0 });
  }
  const u = updateWatch(w.id, { enabled: !w.enabled, nextRun: 0, state });
  return summarize(u, buildCtx());
});

// ───────────── Routes : disponibilité (type UptimeRobot) ─────────────

const loadWatch = (ctx) => {
  const w = getWatch(Number(ctx.params.id));
  if (!w) throw new HttpError(404, 'Site introuvable');
  return w;
};

route('GET', '/api/watches/:id/uptime', (ctx) => {
  const w = loadWatch(ctx);
  const now = Date.now();
  const open = db.prepare('SELECT start, reason FROM outages WHERE watch_id = ? AND end IS NULL ORDER BY start DESC LIMIT 1').get(w.id);
  const lastEnd = db.prepare('SELECT MAX(end) e FROM outages WHERE watch_id = ?').get(w.id).e;
  const current = !w.enabled ? { state: 'paused' } : open ? { state: 'down', since: open.start, reason: open.reason } : { state: 'up', since: lastEnd || w.createdAt };
  return {
    current,
    periods: uptimeSummary(w, now),
    // Jours calendaires du navigateur : il transmet son décalage UTC en minutes (ex. +60 pour Paris en hiver).
    bars: uptimeBars(w, clamp(ctx.query.get('tz'), -840, 840, 0), now),
    outages: outageList(w.id, 50, now),
    response: Object.fromEntries(Object.entries(UPTIME_PERIODS).map(([k, d]) => [k, responseStats(w.id, d, now)])),
    since: w.createdAt,
  };
});

route('GET', '/api/watches/:id/series', (ctx) => {
  const w = loadWatch(ctx);
  const range = ['24h', '7d', '30d', '90d'].includes(ctx.query.get('range')) ? ctx.query.get('range') : '24h';
  return { range, points: responseSeries(w.id, range) };
});

// ───────────── Routes : domaine & DNS ─────────────

route('GET', '/api/watches/:id/domain', (ctx) => {
  const w = loadWatch(ctx);
  const s = w.state;
  const host = new URL(w.url).hostname;
  const events = db
    .prepare("SELECT a.*, w.name watch_name FROM alerts a JOIN watches w ON w.id = a.watch_id WHERE a.watch_id = ? AND (a.type LIKE 'dns%' OR a.type LIKE 'rdap%' OR a.type = 'redirect_domain') ORDER BY a.id DESC LIMIT 100")
    .all(w.id);
  const incidents = Object.entries(s.incidents || {}).filter(([k]) => /^(dns|rdap)/.test(k)).map(([key, i]) => ({ key, ...i }));
  return {
    host, domain: registrable(host), zone: s.dns?.zone || '', mode: w.config.mode,
    dns: s.dns || null, resolvers: s.resolvers || {}, rdap: s.rdap || null, incidents, events: events.map(alertRow),
    monitored: { dns: w.config.checks.dns, rdap: w.config.checks.rdap },
  };
});

route('POST', '/api/watches/:id/ack', (ctx) => {
  const id = Number(ctx.params.id);
  db.prepare('UPDATE alerts SET read = 1 WHERE watch_id = ?').run(id);
  rememberDomainAck(id);
  bus.emit('event', { type: 'ack', watchId: id });
  return { ok: true };
});

route('GET', '/api/watches/:id/history', (ctx) => {
  const id = Number(ctx.params.id);
  const rows = db.prepare('SELECT id, ts, hash, title, size, meta FROM snapshots WHERE watch_id = ? ORDER BY id DESC LIMIT 100').all(id);
  return rows.map((r) => ({ id: r.id, ts: r.ts, title: r.title, size: r.size, meta: JSON.parse(r.meta || '{}') }));
});

route('GET', '/api/snapshots/:id/diff', (ctx) => {
  const cur = getSnapshot(Number(ctx.params.id));
  if (!cur) throw new HttpError(404, 'Version introuvable (supprimée par la rétention ?)');
  const against = ctx.query.get('against');
  const prev = against ? getSnapshot(Number(against)) : previousSnapshot(cur.watch_id, cur.id);
  const a = snapshotLines(prev);
  const b = snapshotLines(cur);
  const d = diffLines(a, b);
  return {
    from: prev ? { id: prev.id, ts: prev.ts } : null, to: { id: cur.id, ts: cur.ts },
    added: d.added, removed: d.removed, similarity: d.similarity, hunks: collapse(d.ops, 3),
  };
});

route('GET', '/api/snapshots/:id/text', (ctx) => {
  const s = getSnapshot(Number(ctx.params.id));
  if (!s) throw new HttpError(404, 'Version introuvable');
  return { id: s.id, ts: s.ts, lines: snapshotLines(s) };
});

route('POST', '/api/test-url', async (ctx) => {
  const url = normalizeUrl(ctx.body.url);
  const s = getSettings();
  const cfg = normalizeConfig({ timeoutS: 12 });
  try {
    const p = await fetchPage(url, cfg, s);
    const a = analyze(p, cfg);
    return { ok: true, status: p.status, ms: p.ms, finalUrl: p.finalUrl, title: a.title, redirected: p.chain.length > 1, size: p.size, server: p.server, offDomain: registrable(new URL(p.finalUrl).hostname) !== registrable(new URL(url).hostname) };
  } catch (e) {
    return { ok: false, error: describeError(e).message };
  }
});

// ───────────── Routes : alertes ─────────────

route('GET', '/api/alerts', (ctx) => {
  const q = ctx.query;
  const where = [];
  const args = [];
  if (q.get('watch')) (where.push('a.watch_id = ?'), args.push(Number(q.get('watch'))));
  if (q.get('severity')) (where.push('a.severity = ?'), args.push(q.get('severity')));
  if (q.get('unread') === '1') where.push('a.read = 0');
  if (q.get('before')) (where.push('a.id < ?'), args.push(Number(q.get('before'))));
  const rows = db
    .prepare(`SELECT a.*, w.name watch_name FROM alerts a JOIN watches w ON w.id = a.watch_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.id DESC LIMIT ?`)
    .all(...args, clamp(q.get('limit'), 1, 200, 50));
  return rows.map(alertRow);
});

route('POST', '/api/alerts/read', (ctx) => {
  const { ids, all } = ctx.body;
  if (all) {
    db.prepare('UPDATE alerts SET read = 1').run();
    for (const w of listWatches()) rememberDomainAck(w.id);
  } else if (Array.isArray(ids) && ids.length) {
    const nums = ids.map(Number).filter((n) => Number.isFinite(n));
    if (nums.length) {
      const st = db.prepare('UPDATE alerts SET read = 1 WHERE id = ?');
      nums.forEach((i) => st.run(i));
      const q = nums.map(() => '?').join(',');
      for (const r of db.prepare(`SELECT DISTINCT watch_id FROM alerts WHERE type = 'rdap_expiring' AND id IN (${q})`).all(...nums)) rememberDomainAck(r.watch_id);
    }
  }
  bus.emit('event', { type: 'ack' });
  return { ok: true };
});

// ───────────── Routes : réglages / Telegram ─────────────

route('GET', '/api/settings', () => publicSettings());

route('PUT', '/api/settings', (ctx) => {
  const b = ctx.body;
  const cur = getSettings();
  const patch = {};
  if (b.telegram) {
    const t = b.telegram;
    patch.telegram = {
      token: t.token ? String(t.token).trim() : cur.telegram.token,
      chatId: t.chatId !== undefined ? String(t.chatId).trim() : cur.telegram.chatId,
      enabled: t.enabled !== undefined ? !!t.enabled : cur.telegram.enabled,
      minSeverity: ['info', 'warning', 'critical'].includes(t.minSeverity) ? t.minSeverity : cur.telegram.minSeverity,
      sendRecovery: t.sendRecovery !== undefined ? !!t.sendRecovery : cur.telegram.sendRecovery,
      includeDiff: t.includeDiff !== undefined ? !!t.includeDiff : cur.telegram.includeDiff,
      sendScreenshot: t.sendScreenshot !== undefined ? !!t.sendScreenshot : cur.telegram.sendScreenshot,
    };
    if (t.clearToken) patch.telegram.token = '';
  }
  if (b.baseUrl !== undefined) patch.baseUrl = String(b.baseUrl).trim().replace(/\/+$/, '');
  if (b.defaultInterval !== undefined) patch.defaultInterval = clamp(b.defaultInterval, 1, 10080, 15);
  if (b.userAgent !== undefined) patch.userAgent = String(b.userAgent).trim() || cur.userAgent;
  if (Array.isArray(b.builtinKeywords)) patch.builtinKeywords = b.builtinKeywords.map((s) => String(s).trim()).filter(Boolean).slice(0, 300);
  saveSettings(patch);
  return publicSettings();
});

const tokenFrom = (body) => String(body.token || '').trim() || getSettings().telegram.token;

route('POST', '/api/telegram/test', async (ctx) => {
  const token = tokenFrom(ctx.body);
  const chatId = String(ctx.body.chatId || '').trim() || getSettings().telegram.chatId;
  try {
    const me = await tg.getMe(token);
    await tg.sendMessage(token, chatId, `✅ <b>VigieWeb est connecté</b>\nLes alertes de surveillance arriveront ici.\n<i>Bot : @${me.username}</i>`);
    return { ok: true, bot: me.username };
  } catch (e) {
    throw new HttpError(400, e.message);
  }
});

route('POST', '/api/telegram/detect', async (ctx) => {
  try {
    const token = tokenFrom(ctx.body);
    const me = await tg.getMe(token);
    return { bot: me.username, chats: await tg.detectChats(token) };
  } catch (e) {
    throw new HttpError(400, e.message);
  }
});

// ───────────── Routes : export / import / temps réel ─────────────

route('GET', '/api/export', (ctx) => {
  ctx.headers['content-disposition'] = 'attachment; filename="vigie-sites.json"';
  const groups = listGroups();
  const nameOf = new Map(groups.map((g) => [g.id, g.name]));
  return {
    version: 2,
    groups: groups.map((g) => ({ name: g.name, color: g.color, collapsed: g.collapsed })),
    // Les identifiants de groupe sont propres à chaque installation : on exporte le NOM du groupe.
    watches: listWatches().map((w) => ({ name: w.name, url: w.url, interval: w.interval, tags: w.tags, enabled: w.enabled, config: w.config, group: nameOf.get(w.groupId) ?? null })),
  };
});

route('POST', '/api/import', async (ctx) => {
  const list = Array.isArray(ctx.body.watches) ? ctx.body.watches : [];
  const have = new Set(listWatches().map((w) => w.url));
  // Groupes retrouvés par leur nom (sans tenir compte de la casse) ou créés à la volée.
  const byName = new Map(listGroups().map((g) => [g.name.toLowerCase(), g.id]));
  const colors = new Map((Array.isArray(ctx.body.groups) ? ctx.body.groups : []).map((g) => [String(g?.name ?? '').toLowerCase(), g.color]));
  const groupFor = (name) => {
    const n = String(name ?? '').trim();
    if (!n) return null;
    if (!byName.has(n.toLowerCase())) {
      try {
        byName.set(n.toLowerCase(), createGroup({ name: n, color: colors.get(n.toLowerCase()) }).id);
      } catch {
        return null; // nom invalide : le site est importé sans groupe
      }
    }
    return byName.get(n.toLowerCase());
  };
  let added = 0;
  for (const it of list.slice(0, 500)) {
    try {
      const { data } = watchInput({ ...it, groupId: undefined });
      data.groupId = groupFor(it.group);
      if (have.has(data.url)) continue;
      enqueue(createWatch(data).id);
      have.add(data.url);
      added++;
    } catch {
      /* entrée ignorée */
    }
  }
  return { added, skipped: list.length - added };
});

route('GET', '/api/events', (ctx) => {
  const { req, res } = ctx;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write('retry: 3000\n\n');
  const on = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  bus.on('event', on);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    bus.off('event', on);
    clearInterval(ping);
  });
  return Symbol.for('handled');
});

// ───────────── Fichiers statiques ─────────────

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };

async function serveStatic(req, res, pathname) {
  let rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  if (!rel || rel.endsWith('/')) rel += 'index.html';
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'Interdit' });
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
}

// ───────────── Serveur ─────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (!url.pathname.startsWith('/api/')) return await serveStatic(req, res, url.pathname);
    const r = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
    if (!r) return send(res, 404, { error: 'Route inconnue' });
    if (!r.public && !validSession(req)) return send(res, 401, { error: 'Authentification requise' });
    // Protection CSRF : un navigateur ne peut pas poster du JSON cross-origin sans pré-requête CORS.
    const hasBody = Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding'];
    if (req.method !== 'GET' && hasBody && !/application\/json/.test(req.headers['content-type'] || '')) {
      return send(res, 415, { error: 'Content-Type application/json requis' });
    }
    if (req.method !== 'GET' && !r.public && !hasBody && !req.headers['content-type'] && req.headers['sec-fetch-site'] === 'cross-site') {
      return send(res, 403, { error: 'Requête inter-sites refusée' });
    }
    const m = r.re.exec(url.pathname);
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    const ctx = { req, res, params, query: url.searchParams, body: req.method === 'GET' ? {} : await readJson(req), headers: {} };
    const out = await r.handler(ctx);
    if (out === Symbol.for('handled')) return;
    send(res, 200, out, ctx.headers);
  } catch (e) {
    if (e instanceof HttpError || e instanceof GroupError) return send(res, e.status, { error: e.message });
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'Erreur interne' });
  }
});

server.listen(PORT, HOST, () => {
  const s = getSettings();
  console.log(`\n  VigieWeb →  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`  Connexion : identifiant « ${CREDS.user} » (VIGIE_USER)`);
  console.log(`  Captures d'écran : ${engine.available() ? `navigateur ${chromePath()}` : 'inactives (aucun Chrome / Chromium détecté — voir CHROME_PATH)'}`);
  if (CREDS.defaultedUser) console.log("  ⚠  VIGIE_USER n'est pas défini : l'identifiant par défaut « admin » est utilisé. Définissez VIGIE_USER pour le personnaliser.");
  console.log(`  Telegram : ${s.telegram.token && s.telegram.chatId ? 'configuré' : 'non configuré (Réglages › Telegram)'}`);
  if (process.env.VIGIE_DEMO === '1') console.log('  ⚠  MODE DÉMO : données fictives, contrôles et captures désactivés (VIGIE_DEMO=1).');
  console.log('');
  startScheduler();
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close();
    db.close();
    process.exit(0);
  });
}
