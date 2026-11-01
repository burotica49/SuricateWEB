import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { clamp } from './util.js';

export const DATA_DIR = process.env.DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(join(DATA_DIR, 'vigie.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS watches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  interval_min INTEGER NOT NULL DEFAULT 15,
  enabled INTEGER NOT NULL DEFAULT 1,
  tags TEXT NOT NULL DEFAULT '[]',
  config TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  next_run INTEGER NOT NULL DEFAULT 0,
  last_check INTEGER,
  last_code INTEGER,
  last_ms INTEGER,
  last_error TEXT
);
CREATE TABLE IF NOT EXISTS checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  code INTEGER,
  ms INTEGER,
  size INTEGER,
  hash TEXT,
  snapshot_id INTEGER,
  error TEXT,
  alerts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_checks_watch ON checks(watch_id, id DESC);
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  hash TEXT NOT NULL,
  text BLOB,
  title TEXT,
  size INTEGER,
  meta TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_snap_watch ON snapshots(watch_id, id DESC);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  severity TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  snapshot_id INTEGER,
  prev_snapshot_id INTEGER,
  read INTEGER NOT NULL DEFAULT 0,
  notified INTEGER NOT NULL DEFAULT 0,
  notify_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_alerts_watch ON alerts(watch_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts(id DESC);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- Groupes de sites (« site_groups » : GROUPS est un mot réservé de SQLite). L'ordre est stocké dans position.
CREATE TABLE IF NOT EXISTS site_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#6366f1',
  position INTEGER NOT NULL DEFAULT 0,
  collapsed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
-- Pannes confirmées : source de vérité du calcul de disponibilité (indépendant de la fréquence des contrôles).
CREATE TABLE IF NOT EXISTS outages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  start INTEGER NOT NULL,
  end INTEGER,
  reason TEXT,
  code INTEGER
);
CREATE INDEX IF NOT EXISTS idx_outages_watch ON outages(watch_id, start DESC);
-- Captures d'écran : les images sont des fichiers dans DATA_DIR/screenshots, ici seulement leurs métadonnées.
CREATE TABLE IF NOT EXISTS screenshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | manual | alert
  file TEXT NOT NULL,
  thumb TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  width INTEGER,
  height INTEGER
);
CREATE INDEX IF NOT EXISTS idx_shots_watch ON screenshots(watch_id, id DESC);
-- Agrégats par jour (UTC) : conservés ~13 mois, alors que le détail des contrôles est purgé.
CREATE TABLE IF NOT EXISTS daily_stats (
  watch_id INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  day INTEGER NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  ok INTEGER NOT NULL DEFAULT 0,
  sum_ms INTEGER NOT NULL DEFAULT 0,
  ms_n INTEGER NOT NULL DEFAULT 0,
  min_ms INTEGER,
  max_ms INTEGER,
  PRIMARY KEY (watch_id, day)
);
`);

// Colonnes ajoutées après la 1re version : migration idempotente (SQLite n'a pas de « ADD COLUMN IF NOT EXISTS »).
{
  const cols = new Set(db.prepare('PRAGMA table_info(watches)').all().map((c) => c.name));
  if (!cols.has('next_shot')) db.exec('ALTER TABLE watches ADD COLUMN next_shot INTEGER NOT NULL DEFAULT 0');
  if (!cols.has('shot_error')) db.exec('ALTER TABLE watches ADD COLUMN shot_error TEXT');
  // Groupe (NULL = « Sans groupe ») et rang du site dans son groupe. Les sites existants gardent l'ordre de création.
  if (!cols.has('group_id')) db.exec('ALTER TABLE watches ADD COLUMN group_id INTEGER');
  if (!cols.has('position')) {
    db.exec('ALTER TABLE watches ADD COLUMN position INTEGER NOT NULL DEFAULT 0');
    db.exec('UPDATE watches SET position = id');
  }
}

const json = (s, fallback) => {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};

// ───────────── Réglages ─────────────

export const DEFAULT_KEYWORDS = [
  // défiguration / revendication
  'hacked by', 'defaced by', 'pwned by', 'h4cked', 'cyber army', 'cyber team', 'greetz to',
  'piraté par', 'hacké par', 'site piraté', 'security breach by',
  // saisie, hébergement suspendu, domaine perdu
  'this domain has been seized', 'this site has been seized', 'account suspended', 'compte suspendu',
  'this domain is for sale', 'domain is for sale', 'buy this domain', 'ce domaine est à vendre', 'ce nom de domaine est à vendre',
  'this domain may be for sale', 'domain expired', 'domaine expiré',
  // pages par défaut de serveur (site écrasé / serveur réinitialisé)
  'welcome to nginx', 'apache2 ubuntu default page', 'apache2 debian default page', 'iis windows server', 'index of /',
  // spam SEO injecté
  'viagra', 'cialis', 'payday loan', 'replica watches', 'louis vuitton outlet', 'casino online', 'online casino', 'porn',
];

const DEFAULT_SETTINGS = {
  telegram: { token: '', chatId: '', enabled: true, minSeverity: 'warning', sendRecovery: true, includeDiff: true, sendScreenshot: true },
  baseUrl: '',
  defaultInterval: 15,
  userAgent: 'Mozilla/5.0 (compatible; VigieWeb/1.0; surveillance de site)',
  builtinKeywords: DEFAULT_KEYWORDS,
  retention: { checks: 10000, snapshots: 300, screenshots: 168 },
  sessionSecret: '',
};

let settingsCache = null;

export function getSettings() {
  if (settingsCache) return settingsCache;
  const row = db.prepare("SELECT value FROM settings WHERE key = 'app'").get();
  const saved = row ? json(row.value, {}) : {};
  const s = {
    ...DEFAULT_SETTINGS,
    ...saved,
    telegram: { ...DEFAULT_SETTINGS.telegram, ...saved.telegram },
    retention: { ...DEFAULT_SETTINGS.retention, ...saved.retention },
  };
  let dirty = false;
  if (!s.sessionSecret) {
    s.sessionSecret = randomBytes(32).toString('hex');
    dirty = true;
  }
  // Les valeurs par défaut sont copiées en base au 1er démarrage : toute évolution passe par une migration.
  const version = s.settingsVersion ?? (s.keywordsVersion === 2 ? 2 : 0);
  if (version < 2) {
    // v2 : expressions trop ambiguës (« family owned by… », « he was here »).
    s.builtinKeywords = s.builtinKeywords.filter((k) => !['owned by', 'was here'].includes(k));
  }
  // v3 : le calcul de disponibilité sur 7 jours à 1 min a besoin de plus de 3000 contrôles conservés.
  if (version < 3 && s.retention.checks === 3000) s.retention.checks = 10000;
  if (version < 4) {
    // v4 : les identifiants viennent désormais uniquement du .env ; l'ancien hash stocké en base est effacé.
    delete s.passwordHash;
    delete s.keywordsVersion;
  }
  if (version < 5) {
    // v5 : le produit s'appelle VigieWeb. Le User-Agent par défaut déjà copié en base suit, mais un User-Agent
    // personnalisé n'est jamais touché. (Chaîne volontairement coupée : un futur renommage global ne doit pas la casser.)
    const oldDefault = ['Mozilla/5.0 (compatible; ', 'Vigie', '/1.0; surveillance de site)'].join('');
    if (s.userAgent === oldDefault) s.userAgent = DEFAULT_SETTINGS.userAgent;
    s.settingsVersion = 5;
    dirty = true;
  }
  if (dirty) persistSettings(s);
  settingsCache = s;
  return s;
}

function persistSettings(s) {
  db.prepare("INSERT INTO settings(key, value) VALUES('app', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(s));
}

export function saveSettings(patch) {
  const cur = getSettings();
  const next = { ...cur, ...patch, telegram: { ...cur.telegram, ...patch.telegram }, retention: { ...cur.retention, ...patch.retention } };
  persistSettings(next);
  settingsCache = next;
  return next;
}

// ───────────── Sites surveillés ─────────────

export const defaultConfig = () => ({
  mode: 'site', // 'site' = site web complet · 'domain' = nom de domaine seul (DNS + registre, sans HTTP)
  selector: '',
  excludeSelector: '',
  ignoreRegex: [],
  images: false,
  userAgent: '',
  timeoutS: 20,
  headers: {},
  allowedHosts: [],
  failThreshold: 2,
  forbidden: [],
  required: [],
  minChangePct: 0,
  notify: true,
  minSeverity: '',
  // Capture d'écran périodique (nécessite Chrome/Chromium sur le serveur). interval en minutes.
  // delay : attente (s) après chargement et défilement · interact : simule un visiteur (souris, molette) ·
  // hideBanners : masque les bandeaux de cookies.
  screenshot: { enabled: true, interval: 60, fullPage: false, width: 1280, height: 800, delay: 3, interact: true, hideBanners: true },
  checks: {
    content: true, keywords: true, title: true, sizeDrop: true, scripts: true, links: true,
    redirect: true, status: true, tls: true, dns: true, rdap: true, server: true,
  },
});

const strList = (v, max = 100) => (Array.isArray(v) ? v : String(v ?? '').split('\n')).map((x) => String(x).trim()).filter(Boolean).slice(0, max);

export function normalizeConfig(input = {}) {
  const d = defaultConfig();
  const c = { ...d, ...input, checks: { ...d.checks, ...(input.checks || {}) } };
  for (const k of Object.keys(d.checks)) c.checks[k] = !!c.checks[k];
  c.mode = c.mode === 'domain' ? 'domain' : 'site';
  const sc = { ...d.screenshot, ...(input.screenshot && typeof input.screenshot === 'object' ? input.screenshot : {}) };
  c.screenshot = {
    enabled: sc.enabled !== false,
    interval: clamp(sc.interval, 5, 10080, 60),
    fullPage: !!sc.fullPage,
    width: Math.round(clamp(sc.width, 320, 1920, 1280)),
    height: Math.round(clamp(sc.height, 400, 1200, 800)),
    delay: Math.round(clamp(sc.delay, 0, 30, 3)),
    interact: sc.interact !== false,
    hideBanners: sc.hideBanners !== false,
  };
  c.selector = String(c.selector || '').trim();
  c.excludeSelector = String(c.excludeSelector || '').trim();
  c.userAgent = String(c.userAgent || '').trim();
  c.images = !!c.images;
  c.notify = c.notify !== false;
  c.minSeverity = ['info', 'warning', 'critical'].includes(c.minSeverity) ? c.minSeverity : '';
  c.timeoutS = clamp(c.timeoutS, 3, 60, 20);
  c.failThreshold = clamp(c.failThreshold, 1, 10, 2);
  c.minChangePct = clamp(c.minChangePct, 0, 100, 0);
  c.ignoreRegex = strList(c.ignoreRegex);
  c.forbidden = strList(c.forbidden);
  c.required = strList(c.required);
  c.allowedHosts = strList(c.allowedHosts).map((h) => h.toLowerCase());
  const headers = {};
  for (const [k, v] of Object.entries(c.headers && typeof c.headers === 'object' ? c.headers : {})) {
    if (/^[\w-]+$/.test(k) && String(v).length < 2000) headers[k.toLowerCase()] = String(v);
  }
  c.headers = headers;
  return c;
}

const rowToWatch = (r) =>
  r && {
    id: r.id,
    name: r.name,
    url: r.url,
    interval: r.interval_min,
    enabled: !!r.enabled,
    tags: json(r.tags, []),
    config: normalizeConfig(json(r.config, {})),
    state: json(r.state, {}),
    createdAt: r.created_at,
    nextRun: r.next_run,
    lastCheck: r.last_check,
    lastCode: r.last_code,
    lastMs: r.last_ms,
    lastError: r.last_error,
    nextShot: r.next_shot,
    shotError: r.shot_error,
    groupId: r.group_id ?? null,
    position: r.position,
  };

export const listWatches = () => db.prepare('SELECT * FROM watches ORDER BY position, name COLLATE NOCASE').all().map(rowToWatch);
export const getWatch = (id) => rowToWatch(db.prepare('SELECT * FROM watches WHERE id = ?').get(id));

/** Rang suivant dans un groupe (null = « Sans groupe »). */
const nextPosition = (groupId) => db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM watches WHERE group_id IS ?').get(groupId ?? null).p;

export function createWatch({ name, url, interval, tags = [], config = {}, enabled = true, groupId = null }) {
  const r = db
    .prepare('INSERT INTO watches(name, url, interval_min, enabled, tags, config, created_at, next_run, group_id, position) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(name, url, interval, enabled ? 1 : 0, JSON.stringify(tags), JSON.stringify(normalizeConfig(config)), Date.now(), 0, groupId ?? null, nextPosition(groupId));
  return getWatch(Number(r.lastInsertRowid));
}

export function updateWatch(id, p) {
  const w = getWatch(id);
  if (!w) return null;
  const n = { ...w, ...p };
  db.prepare('UPDATE watches SET name=?, url=?, interval_min=?, enabled=?, tags=?, config=?, state=?, next_run=? WHERE id=?').run(
    n.name, n.url, n.interval, n.enabled ? 1 : 0, JSON.stringify(n.tags), JSON.stringify(normalizeConfig(n.config)), JSON.stringify(n.state), n.nextRun, id,
  );
  // next_shot a son propre UPDATE : une capture en cours l'écrit en parallèle, on ne l'écrase que sur demande explicite.
  if (p.nextShot !== undefined) db.prepare('UPDATE watches SET next_shot = ? WHERE id = ?').run(p.nextShot, id);
  // Changer un site de groupe le place à la fin du nouveau groupe ; ne pas changer de groupe ne touche pas à son rang.
  if (p.groupId !== undefined && (p.groupId ?? null) !== w.groupId) {
    db.prepare('UPDATE watches SET group_id = ?, position = ? WHERE id = ?').run(p.groupId ?? null, nextPosition(p.groupId), id);
  }
  return getWatch(id);
}

// ───────────── Captures d'écran (métadonnées) ─────────────

export const SHOTS_DIR = join(DATA_DIR, 'screenshots');

export function insertScreenshot(s) {
  const r = db.prepare('INSERT INTO screenshots(watch_id, ts, kind, file, thumb, size, width, height) VALUES(?,?,?,?,?,?,?,?)')
    .run(s.watchId, s.ts, s.kind, s.file, s.thumb ?? null, s.size ?? 0, s.width ?? null, s.height ?? null);
  return Number(r.lastInsertRowid);
}

export const getScreenshot = (id) => db.prepare('SELECT * FROM screenshots WHERE id = ?').get(id);

export const listScreenshots = (watchId, limit = 120) =>
  db.prepare('SELECT id, ts, kind, size, width, height FROM screenshots WHERE watch_id = ? ORDER BY id DESC LIMIT ?').all(watchId, limit);

/** Dernière capture de chaque site : { [watchId]: { id, ts } }. */
export const latestScreenshots = () =>
  Object.fromEntries(db.prepare('SELECT watch_id, id, ts FROM screenshots WHERE id IN (SELECT MAX(id) FROM screenshots GROUP BY watch_id)').all()
    .map((r) => [r.watch_id, { id: r.id, ts: r.ts }]));

/** Captures à supprimer : au-delà de `keep` pour les planifiées, au-delà de `keepOther` pour les manuelles / d'alerte. */
export function screenshotsToPrune(watchId, keep, keepOther = 100) {
  const sel = (cond, n) => db.prepare(`SELECT id, file, thumb FROM screenshots WHERE watch_id = ? AND ${cond} ORDER BY id DESC LIMIT -1 OFFSET ?`).all(watchId, n);
  return [...sel("kind = 'scheduled'", keep), ...sel("kind != 'scheduled'", keepOther)];
}

export function deleteScreenshotRows(ids) {
  const st = db.prepare('DELETE FROM screenshots WHERE id = ?');
  for (const id of ids) st.run(id);
}

export const setShotState = (watchId, { nextShot, error = null }) =>
  db.prepare('UPDATE watches SET next_shot = ?, shot_error = ? WHERE id = ?').run(nextShot, error, watchId);

export const deleteWatch = (id) => db.prepare('DELETE FROM watches WHERE id = ?').run(id).changes > 0;

// ───────────── Groupes de sites ─────────────

export const GROUP_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#64748b'];

/** Erreur de validation : le message est destiné à l'utilisateur (l'API la renvoie en 400 / 409). */
export class GroupError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Transaction : tout ou rien. Une réorganisation à moitié appliquée corromprait l'ordre. */
function transaction(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

const rowToGroup = (r) => (r ? { id: r.id, name: r.name, color: r.color, position: r.position, collapsed: !!r.collapsed } : null);

export const listGroups = () => db.prepare('SELECT * FROM site_groups ORDER BY position, id').all().map(rowToGroup);
export const getGroup = (id) => rowToGroup(db.prepare('SELECT * FROM site_groups WHERE id = ?').get(id));

function cleanGroupName(name, exceptId = null) {
  const n = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (!n) throw new GroupError('Le nom du groupe est obligatoire');
  if (n.length > 40) throw new GroupError('Le nom du groupe est limité à 40 caractères');
  const dup = db.prepare('SELECT id FROM site_groups WHERE LOWER(name) = LOWER(?) AND id IS NOT ?').get(n, exceptId);
  if (dup) throw new GroupError(`Un groupe « ${n} » existe déjà`, 409);
  return n;
}

const cleanColor = (c) => (GROUP_COLORS.includes(c) || /^#[0-9a-f]{6}$/i.test(String(c)) ? String(c).toLowerCase() : GROUP_COLORS[0]);

export function createGroup({ name, color }) {
  const n = cleanGroupName(name);
  const pos = db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM site_groups').get().p;
  const r = db.prepare('INSERT INTO site_groups(name, color, position, created_at) VALUES(?,?,?,?)').run(n, cleanColor(color), pos, Date.now());
  return getGroup(Number(r.lastInsertRowid));
}

export function updateGroup(id, patch) {
  const g = getGroup(id);
  if (!g) return null;
  const next = {
    name: patch.name !== undefined ? cleanGroupName(patch.name, id) : g.name,
    color: patch.color !== undefined ? cleanColor(patch.color) : g.color,
    collapsed: patch.collapsed !== undefined ? !!patch.collapsed : g.collapsed,
  };
  db.prepare('UPDATE site_groups SET name = ?, color = ?, collapsed = ? WHERE id = ?').run(next.name, next.color, next.collapsed ? 1 : 0, id);
  return getGroup(id);
}

/** Supprime le groupe ; ses sites ne sont JAMAIS supprimés : ils passent dans « Sans groupe » (à la fin, dans leur ordre). */
export function deleteGroup(id) {
  if (!getGroup(id)) return false;
  transaction(() => {
    const members = db.prepare('SELECT id FROM watches WHERE group_id = ? ORDER BY position, id').all(id);
    let pos = nextPosition(null);
    for (const m of members) db.prepare('UPDATE watches SET group_id = NULL, position = ? WHERE id = ?').run(pos++, m.id);
    db.prepare('DELETE FROM site_groups WHERE id = ?').run(id);
    renumberGroups();
  });
  return true;
}

/** Rend les rangs des groupes consécutifs (1, 2, 3…), en conservant l'ordre. */
function renumberGroups() {
  listGroups().forEach((g, i) => db.prepare('UPDATE site_groups SET position = ? WHERE id = ?').run(i + 1, g.id));
}

/**
 * Applique d'un coup une organisation complète, telle qu'issue d'un glisser-déposer :
 *   groups : identifiants des groupes dans l'ordre voulu (ceux qui manquent suivent, dans leur ordre actuel)
 *   items  : [{ groupId: id | null, ids: [sites dans l'ordre] }]  (null = « Sans groupe »)
 * Tout est validé AVANT d'écrire quoi que ce soit, puis appliqué dans une transaction.
 */
export function applyLayout({ groups = [], items = [] }) {
  if (!Array.isArray(groups) || !Array.isArray(items)) throw new GroupError('Organisation invalide');
  const groupIds = new Set(db.prepare('SELECT id FROM site_groups').all().map((r) => r.id));
  const watchIds = new Set(db.prepare('SELECT id FROM watches').all().map((r) => r.id));

  const order = groups.map(Number);
  if (order.some((g) => !groupIds.has(g))) throw new GroupError('Groupe inconnu dans l\'organisation');
  if (new Set(order).size !== order.length) throw new GroupError('Groupe en double dans l\'organisation');

  const seen = new Set();
  const lists = items.map((it) => {
    const gid = it?.groupId === null || it?.groupId === undefined ? null : Number(it.groupId);
    if (gid !== null && !groupIds.has(gid)) throw new GroupError('Groupe inconnu dans l\'organisation');
    if (!Array.isArray(it.ids)) throw new GroupError('Liste de sites invalide');
    const ids = it.ids.map(Number);
    for (const id of ids) {
      if (!watchIds.has(id)) throw new GroupError(`Site inconnu dans l'organisation : ${id}`);
      if (seen.has(id)) throw new GroupError(`Site en double dans l'organisation : ${id}`);
      seen.add(id);
    }
    return { gid, ids };
  });

  transaction(() => {
    const rest = listGroups().map((g) => g.id).filter((id) => !order.includes(id));
    [...order, ...rest].forEach((id, i) => db.prepare('UPDATE site_groups SET position = ? WHERE id = ?').run(i + 1, id));
    const upd = db.prepare('UPDATE watches SET group_id = ?, position = ? WHERE id = ?');
    for (const { gid, ids } of lists) ids.forEach((id, i) => upd.run(gid, i + 1, id));
  });
}

export function saveRun(id, { state, nextRun, code, ms, error }) {
  db.prepare('UPDATE watches SET state=?, next_run=?, last_check=?, last_code=?, last_ms=?, last_error=? WHERE id=?').run(
    JSON.stringify(state), nextRun, Date.now(), code ?? null, ms ?? null, error ?? null, id,
  );
}

// ───────────── Snapshots / contrôles / alertes ─────────────

const MAX_TEXT = 1_500_000;

export function insertSnapshot(watchId, { hash, lines, title, size, meta }) {
  let text = lines.join('\n');
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);
  const r = db
    .prepare('INSERT INTO snapshots(watch_id, ts, hash, text, title, size, meta) VALUES(?,?,?,?,?,?,?)')
    .run(watchId, Date.now(), hash, gzipSync(Buffer.from(text, 'utf8')), title ?? '', size ?? 0, JSON.stringify(meta || {}));
  return Number(r.lastInsertRowid);
}

export const latestSnapshot = (watchId) => db.prepare('SELECT * FROM snapshots WHERE watch_id = ? ORDER BY id DESC LIMIT 1').get(watchId);
export const getSnapshot = (id) => db.prepare('SELECT * FROM snapshots WHERE id = ?').get(id);
export const previousSnapshot = (watchId, id) => db.prepare('SELECT * FROM snapshots WHERE watch_id = ? AND id < ? ORDER BY id DESC LIMIT 1').get(watchId, id);

export function snapshotLines(row) {
  if (!row || !row.text) return [];
  const t = gunzipSync(Buffer.from(row.text)).toString('utf8');
  return t ? t.split('\n') : [];
}

export function insertCheck(c) {
  const r = db
    .prepare('INSERT INTO checks(watch_id, ts, ok, code, ms, size, hash, snapshot_id, error, alerts) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(c.watchId, Date.now(), c.ok ? 1 : 0, c.code ?? null, c.ms ?? null, c.size ?? null, c.hash ?? null, c.snapshotId ?? null, c.error ?? null, c.alerts ?? 0);
  return Number(r.lastInsertRowid);
}

export function insertAlert(a) {
  const r = db
    .prepare('INSERT INTO alerts(watch_id, ts, severity, type, title, detail, snapshot_id, prev_snapshot_id, read) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(a.watchId, Date.now(), a.severity, a.type, a.title, a.detail ?? '', a.snapshotId ?? null, a.prevSnapshotId ?? null, a.severity === 'recovery' ? 1 : 0);
  return Number(r.lastInsertRowid);
}

export function markNotified(ids, error = null) {
  const st = db.prepare('UPDATE alerts SET notified = ?, notify_error = ? WHERE id = ?');
  for (const id of ids) st.run(error ? 0 : 1, error, id);
}

// ───────────── Disponibilité (à la UptimeRobot) ─────────────
//
// La disponibilité est calculée en TEMPS, à partir des pannes confirmées (table outages), et non en
// ratio de contrôles : elle reste exacte quelle que soit la fréquence de contrôle ou la rétention.

export const DAY_MS = 86400e3;

export const openOutage = (watchId, start, reason, code) =>
  Number(db.prepare('INSERT INTO outages(watch_id, start, reason, code) VALUES(?,?,?,?)').run(watchId, start, reason ?? '', code ?? null).lastInsertRowid);

export function closeOutage(id, end) {
  db.prepare('UPDATE outages SET end = ? WHERE id = ? AND end IS NULL').run(end, id);
  return db.prepare('SELECT * FROM outages WHERE id = ?').get(id);
}

export function upsertDaily(watchId, ts, ok, ms) {
  const hasMs = ok && ms != null;
  db.prepare(`
    INSERT INTO daily_stats(watch_id, day, n, ok, sum_ms, ms_n, min_ms, max_ms) VALUES(?,?,1,?,?,?,?,?)
    ON CONFLICT(watch_id, day) DO UPDATE SET
      n = n + 1, ok = ok + excluded.ok, sum_ms = sum_ms + excluded.sum_ms, ms_n = ms_n + excluded.ms_n,
      min_ms = CASE WHEN excluded.min_ms IS NULL THEN min_ms WHEN min_ms IS NULL THEN excluded.min_ms ELSE MIN(min_ms, excluded.min_ms) END,
      max_ms = CASE WHEN excluded.max_ms IS NULL THEN max_ms WHEN max_ms IS NULL THEN excluded.max_ms ELSE MAX(max_ms, excluded.max_ms) END
  `).run(watchId, Math.floor(ts / DAY_MS), ok ? 1 : 0, hasMs ? ms : 0, hasMs ? 1 : 0, hasMs ? ms : null, hasMs ? ms : null);
}

/** Durée d'indisponibilité (ms) sur [from, to] : somme des recouvrements avec les pannes. */
export function downtimeBetween(watchId, from, to, now = Date.now()) {
  const rows = db.prepare('SELECT start, end FROM outages WHERE watch_id = ? AND start < ? AND (end IS NULL OR end > ?)').all(watchId, to, from);
  let t = 0;
  for (const r of rows) t += Math.max(0, Math.min(r.end ?? now, to) - Math.max(r.start, from));
  return t;
}

/** Disponibilité en % sur [from, to], bornée au début de la surveillance. null = pas assez de recul (< 1 min). */
export function uptimeBetween(watch, from, to, now = Date.now()) {
  to = Math.min(to, now);
  const start = Math.max(from, watch.createdAt);
  const span = to - start;
  if (span < 60e3) return { uptime: null, downtime: 0, outages: 0 };
  const down = downtimeBetween(watch.id, start, to, now);
  const outages = db.prepare('SELECT COUNT(*) n FROM outages WHERE watch_id = ? AND start < ? AND (end IS NULL OR end > ?)').get(watch.id, to, start).n;
  return { uptime: Math.max(0, 100 * (1 - down / span)), downtime: down, outages };
}

export const UPTIME_PERIODS = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 };

export function uptimeSummary(watch, now = Date.now()) {
  return Object.fromEntries(Object.entries(UPTIME_PERIODS).map(([k, d]) => [k, uptimeBetween(watch, now - d * DAY_MS, now, now)]));
}

/** 90 jours calendaires (jour local du navigateur, via son décalage UTC en minutes). */
export function uptimeBars(watch, tzMinutes = 0, now = Date.now(), days = 90) {
  const off = tzMinutes * 60e3;
  const todayStart = Math.floor((now + off) / DAY_MS) * DAY_MS - off;
  const bars = [];
  for (let i = days - 1; i >= 0; i--) {
    const from = todayStart - i * DAY_MS;
    const to = from + DAY_MS;
    const u = to <= watch.createdAt ? { uptime: null, downtime: 0, outages: 0 } : uptimeBetween(watch, from, to, now);
    bars.push({ from, ...u });
  }
  return bars;
}

export function outageList(watchId, limit = 50, now = Date.now()) {
  return db.prepare('SELECT id, start, end, reason, code FROM outages WHERE watch_id = ? ORDER BY start DESC LIMIT ?').all(watchId, limit)
    .map((o) => ({ ...o, duration: (o.end ?? now) - o.start, ongoing: o.end == null }));
}

/** Temps de réponse moyen / min / max sur N jours (détail des contrôles si dispo, agrégats sinon). */
export function responseStats(watchId, days, now = Date.now()) {
  if (days <= 7) {
    const r = db.prepare('SELECT AVG(ms) avg, MIN(ms) min, MAX(ms) max, COUNT(*) n FROM checks WHERE watch_id = ? AND ok = 1 AND ms IS NOT NULL AND ts > ?').get(watchId, now - days * DAY_MS);
    return { avg: r.avg == null ? null : Math.round(r.avg), min: r.min, max: r.max, n: r.n };
  }
  const r = db.prepare('SELECT SUM(sum_ms) s, SUM(ms_n) n, MIN(min_ms) min, MAX(max_ms) max FROM daily_stats WHERE watch_id = ? AND day > ?').get(watchId, Math.floor(now / DAY_MS) - days);
  return { avg: r.n ? Math.round(r.s / r.n) : null, min: r.min, max: r.max, n: r.n || 0 };
}

/** Série de points {ts, ms, ok} pour le graphique : brut (24 h), horaire (7 j) ou journalier (30/90 j). */
export function responseSeries(watchId, range, now = Date.now()) {
  if (range === '24h') {
    return db.prepare('SELECT ts, ok, ms FROM checks WHERE watch_id = ? AND ts > ? ORDER BY ts').all(watchId, now - DAY_MS)
      .map((r) => ({ ts: r.ts, ms: r.ok ? r.ms : null, ok: !!r.ok }));
  }
  if (range === '7d') {
    const buckets = new Map();
    for (const r of db.prepare('SELECT ts, ok, ms FROM checks WHERE watch_id = ? AND ts > ? ORDER BY ts').all(watchId, now - 7 * DAY_MS)) {
      const k = Math.floor(r.ts / 3600e3);
      const b = buckets.get(k) || { ts: k * 3600e3 + 1800e3, sum: 0, n: 0, ok: true };
      if (r.ok && r.ms != null) { b.sum += r.ms; b.n++; }
      if (!r.ok) b.ok = false;
      buckets.set(k, b);
    }
    return [...buckets.values()].map((b) => ({ ts: b.ts, ms: b.n ? Math.round(b.sum / b.n) : null, ok: b.ok }));
  }
  const days = range === '90d' ? 90 : 30;
  return db.prepare('SELECT day, n, ok, sum_ms, ms_n FROM daily_stats WHERE watch_id = ? AND day > ? ORDER BY day').all(watchId, Math.floor(now / DAY_MS) - days)
    .map((r) => ({ ts: r.day * DAY_MS + DAY_MS / 2, ms: r.ms_n ? Math.round(r.sum_ms / r.ms_n) : null, ok: r.ok === r.n }));
}

export function prune(watchId) {
  const cutoff = Date.now() - 400 * DAY_MS;
  db.prepare('DELETE FROM outages WHERE watch_id = ? AND end IS NOT NULL AND end < ?').run(watchId, cutoff);
  db.prepare('DELETE FROM daily_stats WHERE watch_id = ? AND day < ?').run(watchId, Math.floor(cutoff / DAY_MS));
  const { checks, snapshots } = getSettings().retention;
  db.prepare('DELETE FROM checks WHERE watch_id = ? AND id NOT IN (SELECT id FROM checks WHERE watch_id = ? ORDER BY id DESC LIMIT ?)').run(watchId, watchId, checks);
  db.prepare('DELETE FROM snapshots WHERE watch_id = ? AND id NOT IN (SELECT id FROM snapshots WHERE watch_id = ? ORDER BY id DESC LIMIT ?)').run(watchId, watchId, snapshots);
}
