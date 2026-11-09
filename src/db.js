import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { clamp } from './util.js';
import { openStore, getExtraMigrations, getSecretCodec } from './store/registry.js';
import { migrate } from './store/migrate.js';
import { MIGRATIONS } from './store/migrations/index.js';

export const DATA_DIR = process.env.DATA_DIR || join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
mkdirSync(DATA_DIR, { recursive: true });

// Garde-fou du renommage VigieWeb → SuricateWEB : la base s'appelait « vigie.db ». Sans ce contrôle, une mise à jour qui oublie
// de renommer le fichier créerait en silence une base vide, et tout semblerait perdu. On préfère refuser de démarrer.
if (existsSync(join(DATA_DIR, 'vigie.db')) && !existsSync(join(DATA_DIR, 'suricate.db'))) {
  throw new Error(`Base de données à l'ancien nom : ${join(DATA_DIR, 'vigie.db')}.\n  Renommez-la en « suricate.db » (avec vigie.db-wal et vigie.db-shm s'ils existent), puis relancez.`);
}

// Toute la base passe par cet adaptateur (src/store) : le SQL de ce fichier est portable, le moteur est interchangeable
// (SQLite par défaut ; la version hébergée en fournit un autre via src/store/registry.js avant d'importer ce fichier).
export const db = await openStore({ path: join(DATA_DIR, 'suricate.db'), dataDir: DATA_DIR });
// Le schéma est tenu à jour par des migrations numérotées (src/store/migrations), appliquées ici avant tout le reste.
await migrate(db, [...MIGRATIONS, ...getExtraMigrations()]);

/**
 * Comptes. Dans le cœur il n'y en a qu'un (« compte implicite », identifiant 1). La version hébergée en crée d'autres :
 * chaque site et chaque groupe appartient à un compte (colonne account_id), et tout le reste (contrôles, alertes, captures,
 * versions, pannes, maintenances) en dépend via le site.
 *
 * Convention des fonctions ci-dessous : `accountId` à null (par défaut) = SANS cloisonnement, pour tout ce qui travaille sur
 * l'installation entière (planificateur, contrôles, tests). Le code de l'API ne les appelle jamais ainsi : il passe par
 * ctx.data (src/scoped.js), qui fixe le compte. Les fonctions qui créent des lignes prennent le compte implicite par défaut.
 */
export const DEFAULT_ACCOUNT_ID = 1;

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

// ───────────── Réglages : deux niveaux ─────────────
//
// INSTALLATION (ligne « app » de la table settings) : ce qui ne dépend d'aucun compte — secret de signature des sessions,
// adresse publique de SuricateWEB, rétention des contrôles et des versions (politique de stockage), version des migrations de réglages.
// COMPTE (ligne « account:<id> ») : ce que chaque compte règle pour lui — Telegram, mots-clés, User-Agent, intervalle par défaut,
// seuil des mises à jour CMS, nombre de captures conservées. Un compte sans ligne a les valeurs par défaut.
//
// Vue fusionnée (installation + compte) : c'est ce que reçoivent les contrôles, les messages et l'interface.
//   settingsFor(accountId)   asynchrone, pour le compte demandé (les routes, le contrôle d'un site : celui de SON compte)
//   getSettings()            synchrone, pour l'installation et le compte implicite (1) : démarrage, session, lecteur Telegram du cœur
// Les écritures passent par saveAccountSettings / saveInstanceSettings (saveSettings répartit une ancienne écriture entre les deux).
// Limite assumée : le cache du compte implicite et celui de l'installation sont ceux d'un seul processus.

const instanceDefaults = () => ({
  baseUrl: '',
  retention: { checks: 10000, snapshots: 300 },
  sessionSecret: '',
});

export const accountDefaults = () => ({
  // buttons : boutons « Marquer comme lu » / « Ouvrir dans SuricateWEB » sous chaque message.
  telegram: { token: '', chatId: '', enabled: true, minSeverity: 'warning', sendRecovery: true, includeDiff: true, sendScreenshot: true, buttons: true },
  defaultInterval: 15,
  userAgent: 'Mozilla/5.0 (compatible; SuricateWEB/1.0; surveillance de site)',
  builtinKeywords: [...DEFAULT_KEYWORDS],
  retention: { screenshots: 168 },
  // Une mise à jour du CMS en attente depuis plus de N jours déclenche une alerte.
  cmsAfterDays: 7,
});

/** Réglages complets (installation + compte) : la rétention des deux niveaux est regroupée sous « retention ». */
const mergeSettings = (instance, account) => ({ ...instance, ...account, retention: { ...instance.retention, ...account.retention } });

/** Applique une écriture partielle : telegram et retention se fusionnent champ par champ, le reste est remplacé. */
const applyPatch = (cur, patch) => ({ ...cur, ...patch, ...(cur.telegram || patch.telegram ? { telegram: { ...cur.telegram, ...patch.telegram } } : {}), retention: { ...cur.retention, ...patch.retention } });

const ACCOUNT_TTL_MS = 30e3;
let instanceCache = null;
const accountCache = new Map(); // identifiant de compte → { value, at }

// Secrets des réglages (jeton du bot Telegram) : chiffrés AU REPOS quand la version hébergée fournit un codec (store/registry.js),
// en clair sinon. Un secret chiffré se reconnaît à son préfixe « v1: » ; une valeur sans préfixe est du clair d'avant le chiffrement :
// elle reste lisible, et se chiffre à la prochaine écriture (ou tout de suite avec sealStoredSecrets). En mémoire, tout est en clair.
const isSealed = (v) => typeof v === 'string' && /^v\d+:/.test(v);

function openSecrets(value, key) {
  const token = value?.telegram?.token;
  if (!isSealed(token)) return value;
  const codec = getSecretCodec();
  if (!codec) throw new Error(`Réglages « ${key} » : jeton chiffré, mais aucune clé n'est configurée (voir configureStore, secrets)`);
  try {
    return { ...value, telegram: { ...value.telegram, token: codec.open(token) } };
  } catch {
    // Clé changée ou perdue : ne pas faire tomber tout le service pour un compte. Le jeton est considéré comme absent (à ressaisir).
    console.error(`[secrets] Réglages « ${key} » : jeton Telegram illisible avec la clé actuelle (SECRETS_KEY modifiée ?). Il doit être ressaisi.`);
    return { ...value, telegram: { ...value.telegram, token: '' } };
  }
}

function sealSecrets(value) {
  const codec = getSecretCodec();
  const token = value?.telegram?.token;
  if (!codec || typeof token !== 'string' || !token || isSealed(token)) return value;
  return { ...value, telegram: { ...value.telegram, token: codec.seal(token) } };
}

const settingsRow = async (key) => {
  const row = await db.get('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? openSecrets(json(row.value, {}), key) : null;
};
const persistRow = (key, value) =>
  db.run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, JSON.stringify(sealSecrets(value))]);

/**
 * Chiffre tout de suite les secrets encore en clair dans les réglages des comptes (données d'avant l'activation du chiffrement).
 * À appeler au démarrage quand un codec est configuré. Renvoie le nombre de lignes réécrites.
 */
export async function sealStoredSecrets() {
  if (!getSecretCodec()) return 0;
  let n = 0;
  for (const row of await db.all("SELECT key, value FROM settings WHERE key LIKE 'account:%'")) {
    const token = json(row.value, {})?.telegram?.token;
    if (typeof token === 'string' && token && !isSealed(token)) {
      await db.run('UPDATE settings SET value = ? WHERE key = ?', [JSON.stringify(sealSecrets(json(row.value, {}))), row.key]);
      n++;
    }
  }
  return n;
}

/** Réglages de l'installation (secret de session, adresse publique, rétention des contrôles et versions). */
export function getInstanceSettings() {
  if (!instanceCache) throw new Error('Réglages non chargés : db.js n\'a pas fini de démarrer');
  return instanceCache;
}

/** Réglages propres à un compte (sans ceux de l'installation). Relus au bout de 30 s : un autre processus a pu les changer. */
export async function accountSettings(accountId = DEFAULT_ACCOUNT_ID) {
  const hit = accountCache.get(accountId);
  if (hit && Date.now() - hit.at < ACCOUNT_TTL_MS) return hit.value;
  const saved = (await settingsRow(`account:${accountId}`)) ?? {};
  const value = applyPatch(accountDefaults(), saved);
  accountCache.set(accountId, { value, at: accountId === DEFAULT_ACCOUNT_ID ? Infinity : Date.now() });
  return value;
}

/** Réglages complets d'un compte : les siens et ceux de l'installation. C'est la vue qu'utilisent contrôles, messages et interface. */
export async function settingsFor(accountId = DEFAULT_ACCOUNT_ID) {
  return mergeSettings(getInstanceSettings(), await accountSettings(accountId));
}

/** Vue synchrone pour l'installation et le compte implicite (1) : démarrage, session, lecteur Telegram du cœur. */
export function getSettings() {
  const hit = accountCache.get(DEFAULT_ACCOUNT_ID);
  if (!hit) throw new Error('Réglages non chargés : db.js n\'a pas fini de démarrer');
  return mergeSettings(getInstanceSettings(), hit.value);
}

export async function saveAccountSettings(accountId, patch) {
  const next = applyPatch(await accountSettings(accountId), patch);
  await persistRow(`account:${accountId}`, next);
  accountCache.set(accountId, { value: next, at: accountId === DEFAULT_ACCOUNT_ID ? Infinity : Date.now() });
  return next;
}

export async function saveInstanceSettings(patch) {
  const next = applyPatch(getInstanceSettings(), patch);
  await persistRow('app', next);
  instanceCache = next;
  return next;
}

/** Ancienne écriture (tout dans un seul objet) : répartie entre l'installation et le compte implicite. */
export async function saveSettings(patch) {
  const { baseUrl, sessionSecret, settingsVersion, retention = {}, ...account } = patch;
  const { checks, snapshots, ...accountRetention } = retention;
  const instance = {};
  for (const [k, v] of Object.entries({ baseUrl, sessionSecret, settingsVersion })) if (v !== undefined) instance[k] = v;
  if (checks !== undefined || snapshots !== undefined) instance.retention = { ...(checks !== undefined ? { checks } : {}), ...(snapshots !== undefined ? { snapshots } : {}) };
  if (Object.keys(instance).length) await saveInstanceSettings(instance);
  if (Object.keys(account).length || Object.keys(accountRetention).length) await saveAccountSettings(DEFAULT_ACCOUNT_ID, { ...account, ...(Object.keys(accountRetention).length ? { retention: accountRetention } : {}) });
  return getSettings();
}

/**
 * Lecture au démarrage. Les anciennes versions stockaient TOUT dans la ligne « app » : on rejoue d'abord les migrations
 * d'origine sur cet objet complet (v2 à v5), puis la v6 sépare les réglages du compte implicite dans « account:1 », et la v7
 * renomme le User-Agent par défaut de ce compte (changement de nom du produit).
 */
async function loadSettings() {
  const saved = (await settingsRow('app')) ?? {};
  const legacy = { ...instanceDefaults(), ...accountDefaults() };
  const s = {
    ...legacy,
    ...saved,
    telegram: { ...legacy.telegram, ...saved.telegram },
    retention: { ...instanceDefaults().retention, ...accountDefaults().retention, ...saved.retention },
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
    // v5 : premier renommage du produit (anciennement « Vigie »). Le User-Agent par défaut déjà copié en base suit, mais un
    // User-Agent personnalisé n'est jamais touché. (Chaîne volontairement coupée : un futur renommage global ne doit pas la casser.)
    const oldDefault = ['Mozilla/5.0 (compatible; ', 'Vigie', '/1.0; surveillance de site)'].join('');
    if (s.userAgent === oldDefault) s.userAgent = accountDefaults().userAgent;
  }
  if (version < 6) {
    // v6 : les réglages du compte implicite quittent la ligne de l'installation pour « account:1 ».
    await persistRow(`account:${DEFAULT_ACCOUNT_ID}`, {
      telegram: s.telegram, defaultInterval: s.defaultInterval, userAgent: s.userAgent, builtinKeywords: s.builtinKeywords,
      retention: { screenshots: s.retention.screenshots }, cmsAfterDays: s.cmsAfterDays,
    });
    dirty = true;
  }
  if (version < 7) {
    // v7 : le produit devient SuricateWEB. Le User-Agent par défaut déjà copié en base (compte implicite, désormais
    // dans « account:1 ») suit ; un User-Agent personnalisé n'est jamais touché. La chaîne de l'ancien nom est coupée
    // pour qu'un futur renommage global du dépôt ne casse pas cette comparaison.
    const previousDefault = ['Mozilla/5.0 (compatible; ', 'Vigie', 'Web/1.0; surveillance de site)'].join('');
    const row = await settingsRow(`account:${DEFAULT_ACCOUNT_ID}`);
    if (row?.userAgent === previousDefault) {
      await persistRow(`account:${DEFAULT_ACCOUNT_ID}`, { ...row, userAgent: accountDefaults().userAgent });
    }
    dirty = true;
  }
  instanceCache = {
    baseUrl: s.baseUrl,
    retention: { checks: s.retention.checks, snapshots: s.retention.snapshots },
    sessionSecret: s.sessionSecret,
    settingsVersion: 7,
  };
  if (dirty || version < 7) await persistRow('app', instanceCache);
  await accountSettings(DEFAULT_ACCOUNT_ID); // met en cache le compte implicite
}

await loadSettings();

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
  // keep : captures planifiées à conserver pour ce site (0 = réglage général, Réglages › Détection).
  screenshot: { enabled: true, interval: 60, fullPage: false, width: 1280, height: 800, delay: 3, interact: true, hideBanners: true, keep: 0 },
  checks: {
    content: true, keywords: true, title: true, sizeDrop: true, scripts: true, links: true,
    redirect: true, status: true, tls: true, dns: true, rdap: true, server: true,
  },
  // Connecteur WordPress / PrestaShop : SuricateWEB interroge le plugin (intervalMin en minutes).
  // alerts : mises à jour en retard / PHP en fin de support · security : intégrité des fichiers et comptes administrateurs.
  cms: { type: '', token: '', path: '', intervalMin: 720, alerts: true, security: true },
  // Pages supplémentaires du même site (panier, contact, connexion…) : [{ url, label }], 10 au plus.
  pages: [],
  // Page de statut publique en lecture seule, à l'adresse /status/<jeton>.
  statusPage: { enabled: false, token: '', title: '' },
});

/** « /panier | Panier » (une par ligne) ou [{ url, label }] : chemin ou adresse complète, et un nom facultatif. */
function pageList(v) {
  const arr = Array.isArray(v) ? v : String(v ?? '').split('\n');
  const out = [];
  const seen = new Set();
  for (const it of arr) {
    let url = typeof it === 'string' ? it : it?.url;
    let label = typeof it === 'string' ? '' : it?.label;
    if (typeof it === 'string' && url.includes('|')) [url, label] = [url.slice(0, url.indexOf('|')), url.slice(url.indexOf('|') + 1)];
    url = String(url ?? '').trim();
    label = String(label ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!url || url.length > 500 || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, label });
    if (out.length >= 10) break;
  }
  return out;
}

const strList = (v, max = 100) => (Array.isArray(v) ? v : String(v ?? '').split('\n')).map((x) => String(x).trim()).filter(Boolean).slice(0, max);

/** Plafond de la limite de captures conservées par site. */
export const MAX_KEEP = 2000;

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
    keep: sc.keep ? Math.round(clamp(sc.keep, 1, MAX_KEEP, 0)) : 0,
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
  const rawCms = input.cms && typeof input.cms === 'object' ? input.cms : {};
  const type = rawCms.type === 'wordpress' || rawCms.type === 'prestashop' ? rawCms.type : '';
  c.cms = {
    type: c.mode === 'domain' ? '' : type,
    token: String(rawCms.token ?? '').trim().slice(0, 200),
    path: String(rawCms.path ?? '').trim().replace(/^\/+|\/+$/g, '').slice(0, 120),
    intervalMin: Math.round(clamp(rawCms.intervalMin, 60, 10080, 720)),
    alerts: rawCms.alerts !== false,
    security: rawCms.security !== false,
  };
  c.pages = c.mode === 'domain' ? [] : pageList(input.pages);
  const rawStatus = input.statusPage && typeof input.statusPage === 'object' ? input.statusPage : {};
  c.statusPage = {
    enabled: c.mode !== 'domain' && !!rawStatus.enabled,
    token: /^[A-Za-z0-9_-]{16,64}$/.test(String(rawStatus.token ?? '')) ? String(rawStatus.token) : '',
    title: String(rawStatus.title ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80),
  };
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
    nextCms: r.next_cms ?? 0,
    shotError: r.shot_error,
    groupId: r.group_id ?? null,
    position: r.position,
    accountId: r.account_id ?? DEFAULT_ACCOUNT_ID,
  };

/** Site dont la page de statut publique porte ce jeton, ou null. Le jeton est validé avant d'entrer dans la requête. */
export async function getWatchByStatusToken(token) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(token ?? ''))) return null;
  const rows = await db.all('SELECT * FROM watches WHERE config LIKE ?', [`%${token}%`]);
  for (const r of rows) {
    const w = rowToWatch(r);
    if (w.config.statusPage.enabled && w.config.statusPage.token === token) return w;
  }
  return null;
}

/**
 * Un site (autre que `exceptId`) utilise-t-il déjà ce jeton de page de statut ? Le jeton est l'unique accès à une page
 * publique : il doit être unique dans TOUTE l'installation, tous comptes confondus.
 */
export async function statusTokenInUse(token, exceptId = null) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(token ?? ''))) return false;
  for (const r of await db.all('SELECT * FROM watches WHERE config LIKE ?', [`%${token}%`])) {
    if (r.id !== exceptId && rowToWatch(r).config.statusPage.token === token) return true;
  }
  return false;
}

/** Compte propriétaire d'un site, ou null s'il n'existe pas (le flux temps réel s'en sert pour router les événements). */
export async function watchAccountId(id) {
  const r = await db.get('SELECT account_id FROM watches WHERE id = ?', [id]);
  return r ? r.account_id : null;
}

export const listWatches = async (accountId = null) =>
  (await (accountId === null
    ? db.all('SELECT * FROM watches ORDER BY position, LOWER(name)')
    : db.all('SELECT * FROM watches WHERE account_id = ? ORDER BY position, LOWER(name)', [accountId]))).map(rowToWatch);
export const getWatch = async (id) => rowToWatch(await db.get('SELECT * FROM watches WHERE id = ?', [id]));

/** Rang suivant dans un groupe (null = « Sans groupe ») du compte. */
// IS NOT DISTINCT FROM : égalité qui accepte NULL (« Sans groupe »), valable sous SQLite comme sous PostgreSQL.
// `q` : la base, ou la transaction en cours (tout ce qui est lu dans une transaction doit passer par elle).
const nextPosition = async (groupId, q = db, accountId = null) =>
  (await (accountId === null
    ? q.get('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM watches WHERE group_id IS NOT DISTINCT FROM ?', [groupId ?? null])
    : q.get('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM watches WHERE account_id = ? AND group_id IS NOT DISTINCT FROM ?', [accountId, groupId ?? null]))).p;

export async function createWatch({ name, url, interval, tags = [], config = {}, enabled = true, groupId = null, accountId = DEFAULT_ACCOUNT_ID }) {
  const id = await db.insert('INSERT INTO watches(name, url, interval_min, enabled, tags, config, created_at, next_run, group_id, position, account_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)', [name, url, interval, enabled ? 1 : 0, JSON.stringify(tags), JSON.stringify(normalizeConfig(config)), Date.now(), 0, groupId ?? null, await nextPosition(groupId, db, accountId), accountId]);
  return await getWatch(id);
}

export async function updateWatch(id, p) {
  const w = await getWatch(id);
  if (!w) return null;
  const n = { ...w, ...p };
  await db.run('UPDATE watches SET name=?, url=?, interval_min=?, enabled=?, tags=?, config=?, state=?, next_run=? WHERE id=?', [n.name, n.url, n.interval, n.enabled ? 1 : 0, JSON.stringify(n.tags), JSON.stringify(normalizeConfig(n.config)), JSON.stringify(n.state), n.nextRun, id,]);
  // next_shot a son propre UPDATE : une capture en cours l'écrit en parallèle, on ne l'écrase que sur demande explicite.
  if (p.nextShot !== undefined) await db.run('UPDATE watches SET next_shot = ? WHERE id = ?', [p.nextShot, id]);
  if (p.nextCms !== undefined) await db.run('UPDATE watches SET next_cms = ? WHERE id = ?', [p.nextCms, id]);
  // Changer un site de groupe le place à la fin du nouveau groupe ; ne pas changer de groupe ne touche pas à son rang.
  if (p.groupId !== undefined && (p.groupId ?? null) !== w.groupId) {
    await db.run('UPDATE watches SET group_id = ?, position = ? WHERE id = ?', [p.groupId ?? null, await nextPosition(p.groupId, db, w.accountId), id]);
  }
  return await getWatch(id);
}

// ───────────── Captures d'écran (métadonnées) ─────────────

export const SHOTS_DIR = join(DATA_DIR, 'screenshots');

export async function insertScreenshot(s) {
  const id = await db.insert('INSERT INTO screenshots(watch_id, ts, kind, file, thumb, size, width, height, final_url, page_title) VALUES(?,?,?,?,?,?,?,?,?,?)', [s.watchId, s.ts, s.kind, s.file, s.thumb ?? null, s.size ?? 0, s.width ?? null, s.height ?? null, s.finalUrl ?? null, s.title ?? null]);
  return id;
}

export const getScreenshot = async (id) => db.get('SELECT * FROM screenshots WHERE id = ?', [id]);

/** Nombre et poids (octets, images seules) des captures d'un site. */
export const screenshotStats = async (watchId) => db.get('SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM screenshots WHERE watch_id = ?', [watchId]);
/** Idem pour tous les sites (ceux d'un compte, si `accountId` est donné). */
export const screenshotUsage = async (accountId = null) =>
  accountId === null
    ? db.get('SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM screenshots')
    : db.get('SELECT COUNT(*) AS count, COALESCE(SUM(s.size), 0) AS bytes FROM screenshots s JOIN watches w ON w.id = s.watch_id WHERE w.account_id = ?', [accountId]);

export const listScreenshots = async (watchId, limit = 120) =>
  await db.all('SELECT id, ts, kind, size, width, height, final_url AS "finalUrl", page_title AS title FROM screenshots WHERE watch_id = ? ORDER BY id DESC LIMIT ?', [watchId, limit]);

/** Dernière capture de chaque site : { [watchId]: { id, ts } }. */
export const latestScreenshots = async (accountId = null) =>
  Object.fromEntries((await (accountId === null
    ? db.all('SELECT watch_id, id, ts FROM screenshots WHERE id IN (SELECT MAX(id) FROM screenshots GROUP BY watch_id)')
    : db.all('SELECT watch_id, id, ts FROM screenshots WHERE id IN (SELECT MAX(id) FROM screenshots GROUP BY watch_id) AND watch_id IN (SELECT id FROM watches WHERE account_id = ?)', [accountId])))
    .map((r) => [r.watch_id, { id: r.id, ts: r.ts }]));

/** Captures à supprimer : au-delà de `keep` pour les planifiées, au-delà de `keepOther` pour les manuelles / d'alerte. */
export async function screenshotsToPrune(watchId, keep, keepOther = 100) {
  // OFFSET exige un LIMIT sous SQLite : un très grand LIMIT veut dire « sans limite », et reste valable partout.
  const sel = (cond, n) => db.all(`SELECT id, file, thumb FROM screenshots WHERE watch_id = ? AND ${cond} ORDER BY id DESC LIMIT 1000000000 OFFSET ?`, [watchId, n]);
  return [...(await sel("kind = 'scheduled'", keep)), ...(await sel("kind != 'scheduled'", keepOther))];
}

export async function deleteScreenshotRows(ids) {
  for (const id of ids) await db.run('DELETE FROM screenshots WHERE id = ?', [id]);
}

export const setShotState = async (watchId, { nextShot, error = null }) =>
  await db.run('UPDATE watches SET next_shot = ?, shot_error = ? WHERE id = ?', [nextShot, error, watchId]);

/** Écrit uniquement state.cms et l'échéance, sans écraser le reste de l'état (un contrôle peut écrire en parallèle). */
export async function setCmsReport(id, cms, nextCms) {
  const row = await db.get('SELECT state FROM watches WHERE id = ?', [id]);
  if (!row) return null;
  let state = {};
  try {
    state = JSON.parse(row.state || '{}') || {};
  } catch {
    state = {};
  }
  state.cms = cms;
  await db.run('UPDATE watches SET state = ?, next_cms = ? WHERE id = ?', [JSON.stringify(state), nextCms, id]);
  return await getWatch(id);
}

/** Un relevé du plugin vient d'aboutir : le prochain contrôle part sans attendre, pour que ses alertes ne tardent pas. */
export const wakeWatch = async (id) => db.run('UPDATE watches SET next_run = 0 WHERE id = ? AND enabled = 1 AND next_run > ?', [id, Date.now()]);

export const deleteWatch = async (id) => (await db.run('DELETE FROM watches WHERE id = ?', [id])).changes > 0;

// ───────────── Groupes de sites ─────────────

export const GROUP_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6', '#64748b'];

/** Erreur de validation : le message est destiné à l'utilisateur (l'API la renvoie en 400 / 409). */
export class GroupError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// Les réorganisations (suppression de groupe, glisser-déposer) s'exécutent dans db.transaction : tout ou rien.
// Une organisation à moitié appliquée corromprait l'ordre.

const rowToGroup = (r) => (r ? { id: r.id, name: r.name, color: r.color, position: r.position, collapsed: !!r.collapsed, accountId: r.account_id ?? DEFAULT_ACCOUNT_ID } : null);

/** Groupes d'un compte (tous, si `accountId` est null). `q` : la base, ou la transaction en cours. */
export const listGroups = async (accountId = null, q = db) =>
  (await (accountId === null
    ? q.all('SELECT * FROM site_groups ORDER BY position, id')
    : q.all('SELECT * FROM site_groups WHERE account_id = ? ORDER BY position, id', [accountId]))).map(rowToGroup);
export const getGroup = async (id) => rowToGroup(await db.get('SELECT * FROM site_groups WHERE id = ?', [id]));

/** Le nom d'un groupe est unique DANS son compte : deux comptes peuvent avoir chacun leur groupe « Clients ». */
async function cleanGroupName(name, exceptId = null, accountId = null) {
  const n = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (!n) throw new GroupError('Le nom du groupe est obligatoire');
  if (n.length > 40) throw new GroupError('Le nom du groupe est limité à 40 caractères');
  const dup = await (accountId === null
    ? db.get('SELECT id FROM site_groups WHERE LOWER(name) = LOWER(?) AND id IS DISTINCT FROM ?', [n, exceptId])
    : db.get('SELECT id FROM site_groups WHERE account_id = ? AND LOWER(name) = LOWER(?) AND id IS DISTINCT FROM ?', [accountId, n, exceptId]));
  if (dup) throw new GroupError(`Un groupe « ${n} » existe déjà`, 409);
  return n;
}

const cleanColor = (c) => (GROUP_COLORS.includes(c) || /^#[0-9a-f]{6}$/i.test(String(c)) ? String(c).toLowerCase() : GROUP_COLORS[0]);

export async function createGroup({ name, color, accountId = DEFAULT_ACCOUNT_ID }) {
  const n = await cleanGroupName(name, null, accountId);
  const pos = (await db.get('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM site_groups WHERE account_id = ?', [accountId])).p;
  const id = await db.insert('INSERT INTO site_groups(name, color, position, created_at, account_id) VALUES(?,?,?,?,?)', [n, cleanColor(color), pos, Date.now(), accountId]);
  return await getGroup(id);
}

export async function updateGroup(id, patch) {
  const g = await getGroup(id);
  if (!g) return null;
  const next = {
    name: patch.name !== undefined ? await cleanGroupName(patch.name, id, g.accountId) : g.name,
    color: patch.color !== undefined ? cleanColor(patch.color) : g.color,
    collapsed: patch.collapsed !== undefined ? !!patch.collapsed : g.collapsed,
  };
  await db.run('UPDATE site_groups SET name = ?, color = ?, collapsed = ? WHERE id = ?', [next.name, next.color, next.collapsed ? 1 : 0, id]);
  return await getGroup(id);
}

/** Supprime le groupe ; ses sites ne sont JAMAIS supprimés : ils passent dans « Sans groupe » (à la fin, dans leur ordre). */
export async function deleteGroup(id) {
  const group = await getGroup(id);
  if (!group) return false;
  await db.transaction(async (tx) => {
    const members = await tx.all('SELECT id FROM watches WHERE group_id = ? ORDER BY position, id', [id]);
    let pos = await nextPosition(null, tx, group.accountId);
    for (const m of members) await tx.run('UPDATE watches SET group_id = NULL, position = ? WHERE id = ?', [pos++, m.id]);
    await tx.run('DELETE FROM site_groups WHERE id = ?', [id]);
    await renumberGroups(tx, group.accountId);
  });
  return true;
}

/** Rend les rangs des groupes d'un compte consécutifs (1, 2, 3…), en conservant l'ordre. */
async function renumberGroups(q = db, accountId = null) {
  const groups = await listGroups(accountId, q);
  for (const [i, g] of groups.entries()) await q.run('UPDATE site_groups SET position = ? WHERE id = ?', [i + 1, g.id]);
}

/**
 * Applique d'un coup une organisation complète, telle qu'issue d'un glisser-déposer :
 *   groups : identifiants des groupes dans l'ordre voulu (ceux qui manquent suivent, dans leur ordre actuel)
 *   items  : [{ groupId: id | null, ids: [sites dans l'ordre] }]  (null = « Sans groupe »)
 * Tout est validé AVANT d'écrire quoi que ce soit, puis appliqué dans une transaction.
 * Avec `accountId`, seuls les groupes et les sites de ce compte sont connus : un identifiant étranger est « inconnu ».
 */
export async function applyLayout({ groups = [], items = [] }, accountId = null) {
  if (!Array.isArray(groups) || !Array.isArray(items)) throw new GroupError('Organisation invalide');
  const groupIds = new Set((await listGroups(accountId)).map((g) => g.id));
  const watchIds = new Set((await listWatches(accountId)).map((w) => w.id));

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

  await db.transaction(async (tx) => {
    const rest = (await listGroups(accountId, tx)).map((g) => g.id).filter((id) => !order.includes(id));
    for (const [i, id] of [...order, ...rest].entries()) await tx.run('UPDATE site_groups SET position = ? WHERE id = ?', [i + 1, id]);
    for (const { gid, ids } of lists) {
      for (const [i, id] of ids.entries()) await tx.run('UPDATE watches SET group_id = ?, position = ? WHERE id = ?', [gid, i + 1, id]);
    }
  });
}

export async function saveRun(id, { state, nextRun, code, ms, error }) {
  // Un relevé CMS peut avoir abouti pendant le contrôle : on garde le plus récent.
  const cur = await db.get('SELECT state FROM watches WHERE id = ?', [id]);
  let next = state;
  try {
    const prev = JSON.parse(cur?.state || '{}');
    if (prev?.cms && (prev.cms.checkedAt || 0) > (state?.cms?.checkedAt || 0)) next = { ...state, cms: prev.cms };
  } catch {
    /* l'état en cours d'écriture reste la référence */
  }
  await db.run('UPDATE watches SET state=?, next_run=?, last_check=?, last_code=?, last_ms=?, last_error=? WHERE id=?', [JSON.stringify(next), nextRun, Date.now(), code ?? null, ms ?? null, error ?? null, id,]);
}

// ───────────── Snapshots / contrôles / alertes ─────────────

const MAX_TEXT = 1_500_000;

export async function insertSnapshot(watchId, { hash, lines, title, size, meta }) {
  let text = lines.join('\n');
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);
  const id = await db.insert('INSERT INTO snapshots(watch_id, ts, hash, text, title, size, meta) VALUES(?,?,?,?,?,?,?)', [watchId, Date.now(), hash, gzipSync(Buffer.from(text, 'utf8')), title ?? '', size ?? 0, JSON.stringify(meta || {})]);
  return id;
}

export const latestSnapshot = async (watchId) => db.get('SELECT * FROM snapshots WHERE watch_id = ? ORDER BY id DESC LIMIT 1', [watchId]);
export const getSnapshot = async (id) => db.get('SELECT * FROM snapshots WHERE id = ?', [id]);
export const previousSnapshot = async (watchId, id) => db.get('SELECT * FROM snapshots WHERE watch_id = ? AND id < ? ORDER BY id DESC LIMIT 1', [watchId, id]);

export function snapshotLines(row) {
  if (!row || !row.text) return [];
  const t = gunzipSync(Buffer.from(row.text)).toString('utf8');
  return t ? t.split('\n') : [];
}

export async function insertCheck(c) {
  const id = await db.insert('INSERT INTO checks(watch_id, ts, ok, code, ms, size, hash, snapshot_id, error, alerts) VALUES(?,?,?,?,?,?,?,?,?,?)', [c.watchId, Date.now(), c.ok ? 1 : 0, c.code ?? null, c.ms ?? null, c.size ?? null, c.hash ?? null, c.snapshotId ?? null, c.error ?? null, c.alerts ?? 0]);
  return id;
}

export async function insertAlert(a) {
  // Une alerte retenue pendant une maintenance est d'emblée « lue » : c'est le récapitulatif de fin qui prévient.
  return await db.insert(
    'INSERT INTO alerts(watch_id, ts, severity, type, title, detail, snapshot_id, prev_snapshot_id, read, maintenance) VALUES(?,?,?,?,?,?,?,?,?,?)',
    [a.watchId, Date.now(), a.severity, a.type, a.title, a.detail ?? '', a.snapshotId ?? null, a.prevSnapshotId ?? null, a.severity === 'recovery' || a.maintenance ? 1 : 0, a.maintenance ? 1 : 0],
  );
}

// ───────────── Fenêtres de maintenance ─────────────

const maintRow = (r) => ({ id: r.id, watchId: r.watch_id, start: r.start, end: r.end, note: r.note });

export async function addMaintenance({ watchId, start, end, note = '' }) {
  const id = await db.insert('INSERT INTO maintenance(watch_id, start, "end", note) VALUES(?,?,?,?)', [watchId, start, end, String(note).slice(0, 140)]);
  return maintRow(await db.get('SELECT * FROM maintenance WHERE id = ?', [id]));
}

/** Fenêtre en cours pour ce site (celle qui se termine le plus tard), ou null. */
export async function activeMaintenance(watchId, now = Date.now()) {
  const r = await db.get('SELECT * FROM maintenance WHERE watch_id = ? AND start <= ? AND "end" > ? ORDER BY "end" DESC LIMIT 1', [watchId, now, now]);
  return r ? maintRow(r) : null;
}

/** Fenêtres en cours et à venir, dans l'ordre chronologique. */
export async function listMaintenance(watchId, now = Date.now()) {
  return (await db.all('SELECT * FROM maintenance WHERE watch_id = ? AND "end" > ? ORDER BY start', [watchId, now])).map(maintRow);
}

/** Pour le tableau de bord : site → fenêtre en cours. */
export async function activeMaintenanceMap(now = Date.now(), accountId = null) {
  const map = new Map();
  const rows = accountId === null
    ? await db.all('SELECT * FROM maintenance WHERE start <= ? AND "end" > ? ORDER BY "end"', [now, now])
    : await db.all('SELECT * FROM maintenance WHERE start <= ? AND "end" > ? AND watch_id IN (SELECT id FROM watches WHERE account_id = ?) ORDER BY "end"', [now, now, accountId]);
  for (const r of rows) map.set(r.watch_id, maintRow(r));
  return map;
}

/** Une fenêtre par son identifiant (pour vérifier à qui elle appartient avant d'agir), ou null. */
export async function getMaintenance(id) {
  const r = await db.get('SELECT * FROM maintenance WHERE id = ?', [id]);
  return r ? maintRow(r) : null;
}

/** Fenêtres de maintenance qui recoupent [from, to[ (pour le rapport mensuel). */
export async function maintenanceBetween(watchId, from, to) {
  return (await db.all('SELECT * FROM maintenance WHERE watch_id = ? AND start < ? AND "end" > ? ORDER BY start', [watchId, to, from])).map(maintRow);
}

/** Termine une fenêtre en cours (elle s'arrête maintenant) ou supprime une fenêtre à venir. */
export async function endMaintenance(id, now = Date.now()) {
  const r = await db.get('SELECT * FROM maintenance WHERE id = ?', [id]);
  if (!r || r.end <= now) return null;
  if (r.start > now) await db.run('DELETE FROM maintenance WHERE id = ?', [id]);
  else await db.run('UPDATE maintenance SET "end" = ? WHERE id = ?', [now, id]);
  return maintRow(r);
}

/** Alertes retenues pendant une maintenance et pas encore reprises dans un récapitulatif. */
export const pendingMaintenanceAlerts = async (watchId) =>
  await db.all("SELECT id, severity, type, title FROM alerts WHERE watch_id = ? AND maintenance = 1 AND severity != 'recovery' ORDER BY id", [watchId]);

export async function markMaintenanceSummarized(watchId) {
  await db.run('UPDATE alerts SET maintenance = 2 WHERE watch_id = ? AND maintenance = 1', [watchId]);
}

/** Marque comme lues les alertes non lues d'un site jusqu'à l'alerte `upTo` (bouton Telegram). Retourne les lignes concernées. */
export async function markAlertsReadUpTo(watchId, upTo) {
  const rows = await db.all('SELECT id, type FROM alerts WHERE watch_id = ? AND id <= ? AND read = 0 ORDER BY id', [watchId, upTo]);
  if (rows.length) await db.run('UPDATE alerts SET read = 1 WHERE watch_id = ? AND id <= ? AND read = 0', [watchId, upTo]);
  return rows;
}

export async function markNotified(ids, error = null) {
  for (const id of ids) await db.run('UPDATE alerts SET notified = ?, notify_error = ? WHERE id = ?', [error ? 0 : 1, error, id]);
}

// ───────────── Alertes : lecture et acquittement (API) ─────────────
//
// Tout le SQL vit dans ce fichier : server.js, scheduler.js et report.js n'écrivent plus de requêtes.
// C'est la condition pour brancher plus tard un autre moteur de base derrière les mêmes fonctions.

/** Alertes non lues par site et par gravité : { [siteId]: { critical, warning, info } } (les rétablissements n'y figurent pas). */
export async function unreadAlertCounts(accountId = null) {
  const out = {};
  const rows = accountId === null
    ? await db.all("SELECT watch_id, severity, COUNT(*) n FROM alerts WHERE read = 0 AND severity IN ('critical','warning','info') GROUP BY watch_id, severity")
    : await db.all("SELECT a.watch_id, a.severity, COUNT(*) n FROM alerts a JOIN watches w ON w.id = a.watch_id WHERE a.read = 0 AND a.severity IN ('critical','warning','info') AND w.account_id = ? GROUP BY a.watch_id, a.severity", [accountId]);
  for (const r of rows) {
    (out[r.watch_id] ||= { critical: 0, warning: 0, info: 0 })[r.severity] = r.n;
  }
  return out;
}

/**
 * Dernière alerte d'échéance du domaine déjà émise, par site : { unread, max }.
 * Sert à retirer le rappel de l'accueil une fois lu ; `max` est la gravité la plus haute déjà émise (3 = critique).
 */
export async function domainExpiryAlertState(accountId = null) {
  const map = new Map();
  const rows = await db.all(`
    SELECT a.watch_id, MIN(a.read) = 0 AS unread,
           MAX(CASE a.severity WHEN 'critical' THEN 3 WHEN 'warning' THEN 2 WHEN 'info' THEN 1 ELSE 0 END) AS max
    FROM alerts a ${accountId === null ? '' : 'JOIN watches w ON w.id = a.watch_id'}
    WHERE a.type = 'rdap_expiring' ${accountId === null ? '' : 'AND w.account_id = ?'} GROUP BY a.watch_id
  `, accountId === null ? [] : [accountId]);
  for (const r of rows) map.set(r.watch_id, { unread: !!r.unread, max: r.max });
  return map;
}

/** Alertes filtrées, les plus récentes d'abord, avec le nom du site. Filtres : accountId, watchId, severity, unread, before (id), limit. */
export async function queryAlerts({ accountId = null, watchId = null, severity = '', unread = false, before = null, limit = 50 } = {}) {
  const where = [];
  const args = [];
  if (accountId !== null) (where.push('w.account_id = ?'), args.push(accountId));
  if (watchId !== null) (where.push('a.watch_id = ?'), args.push(watchId));
  if (severity) (where.push('a.severity = ?'), args.push(severity));
  if (unread) where.push('a.read = 0');
  if (before !== null) (where.push('a.id < ?'), args.push(before));
  return await db.all(`SELECT a.*, w.name watch_name FROM alerts a JOIN watches w ON w.id = a.watch_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY a.id DESC LIMIT ?`, [...args, limit]);
}

/** Alertes liées au domaine (DNS, registre, redirection hors domaine) d'un site, avec le nom du site. */
export const domainAlerts = async (watchId, limit = 100) =>
  await db.all("SELECT a.*, w.name watch_name FROM alerts a JOIN watches w ON w.id = a.watch_id WHERE a.watch_id = ? AND (a.type LIKE 'dns%' OR a.type LIKE 'rdap%' OR a.type = 'redirect_domain') ORDER BY a.id DESC LIMIT ?", [watchId, limit]);

/** « Tout est normal » : toutes les alertes d'un site passent en lu. */
export const markWatchAlertsRead = async (watchId) => db.run('UPDATE alerts SET read = 1 WHERE watch_id = ?', [watchId]);

/** « Tout marquer comme lu » : toutes les alertes de l'installation (ou celles des sites d'un compte). */
export const markEveryAlertRead = async (accountId = null) =>
  accountId === null
    ? db.run('UPDATE alerts SET read = 1')
    : db.run('UPDATE alerts SET read = 1 WHERE watch_id IN (SELECT id FROM watches WHERE account_id = ?)', [accountId]);

/**
 * Marque ces alertes comme lues. Retourne les sites qui avaient parmi elles une alerte d'échéance du domaine :
 * l'appelant doit alors mémoriser l'acquittement, comme pour « Tout est normal ».
 */
export async function markAlertsRead(ids, accountId = null) {
  if (!ids.length) return [];
  // Avec un compte, une alerte d'un autre compte est ignorée en silence (comme si elle n'existait pas).
  const mine = accountId === null ? '' : ' AND watch_id IN (SELECT id FROM watches WHERE account_id = ?)';
  const extra = accountId === null ? [] : [accountId];
  for (const id of ids) await db.run(`UPDATE alerts SET read = 1 WHERE id = ?${mine}`, [id, ...extra]);
  const marks = ids.map(() => '?').join(',');
  return (await db.all(`SELECT DISTINCT watch_id FROM alerts WHERE type = 'rdap_expiring' AND id IN (${marks})${mine}`, [...ids, ...extra])).map((r) => r.watch_id);
}

/** Alertes d'une période (hors rétablissements et récapitulatifs de maintenance), pour le rapport : gravités critique et attention. */
export const alertsBetween = async (watchId, from, to) =>
  await db.all("SELECT ts, severity, type, title FROM alerts WHERE watch_id = ? AND ts >= ? AND ts < ? AND severity IN ('critical','warning') AND type != 'maintenance_summary' ORDER BY ts DESC", [watchId, from, to]);

// ───────────── Tableau de bord : statistiques récentes ─────────────

/** Contrôles des dernières 24 h par site : { [siteId]: { uptime (%), avgMs } }. */
export async function checkStatsSince(since, accountId = null) {
  const stats = {};
  const rows = accountId === null
    ? await db.all('SELECT watch_id, COUNT(*) n, SUM(ok) ok, AVG(CASE WHEN ok = 1 THEN ms END) avg FROM checks WHERE ts > ? GROUP BY watch_id', [since])
    : await db.all('SELECT c.watch_id, COUNT(*) n, SUM(c.ok) ok, AVG(CASE WHEN c.ok = 1 THEN c.ms END) avg FROM checks c JOIN watches w ON w.id = c.watch_id WHERE c.ts > ? AND w.account_id = ? GROUP BY c.watch_id', [since, accountId]);
  for (const r of rows) {
    stats[r.watch_id] = { uptime: r.n ? Math.round((r.ok / r.n) * 1000) / 10 : null, avgMs: r.avg ? Math.round(r.avg) : null };
  }
  return stats;
}

const listWatchIds = async (accountId) =>
  accountId === null ? db.all('SELECT id FROM watches') : db.all('SELECT id FROM watches WHERE account_id = ?', [accountId]);

/** Derniers temps de réponse de chaque site (null = échec), du plus ancien au plus récent : { [siteId]: [ms…] }. */
export async function sparklines(limit = 40, accountId = null) {
  const out = {};
  for (const w of await listWatchIds(accountId)) {
    out[w.id] = (await db.all('SELECT ms, ok FROM checks WHERE watch_id = ? ORDER BY id DESC LIMIT ?', [w.id, limit])).reverse().map((r) => (r.ok ? r.ms : null));
  }
  return out;
}

/** Derniers contrôles d'un site, du plus ancien au plus récent. */
export const recentChecks = async (watchId, limit = 200) =>
  (await db.all('SELECT id, ts, ok, code, ms, size, error, alerts FROM checks WHERE watch_id = ? ORDER BY id DESC LIMIT ?', [watchId, limit])).reverse();

/** Liste des versions enregistrées d'un site (sans le texte), les plus récentes d'abord. */
export const snapshotHistory = async (watchId, limit = 100) =>
  await db.all('SELECT id, ts, hash, title, size, meta FROM snapshots WHERE watch_id = ? ORDER BY id DESC LIMIT ?', [watchId, limit]);

// ───────────── Planificateur : échéances ─────────────

/** Sites actifs dont le contrôle est dû, les plus en retard d'abord. */
export const dueWatchIds = async (now, limit = 100) =>
  (await db.all('SELECT id FROM watches WHERE enabled = 1 AND next_run <= ? ORDER BY next_run LIMIT ?', [now, limit])).map((r) => r.id);

/** Lit la configuration d'une ligne : une configuration illisible écarte le site plutôt que de bloquer tout le passage. */
function dueRows(rows) {
  const out = [];
  for (const { id, config } of rows) {
    try {
      out.push({ id, config: normalizeConfig(JSON.parse(config)) });
    } catch {
      /* configuration corrompue : le site est ignoré */
    }
  }
  return out;
}

/** Sites dont le relevé CMS est dû (next_cms > 0 : 0 veut dire « aucun relevé planifié »), avec leur configuration. */
export const dueCmsWatches = async (now) => dueRows(await db.all('SELECT id, config FROM watches WHERE enabled = 1 AND next_cms > 0 AND next_cms <= ?', [now]));

/** Sites dont la capture d'écran est due, avec leur configuration. */
export const dueShotWatches = async (now) => dueRows(await db.all('SELECT id, config FROM watches WHERE enabled = 1 AND next_shot <= ?', [now]));

/** Ferme la base proprement à l'arrêt du serveur (le mode WAL est alors replié dans le fichier principal). */
export const closeDb = () => db.close();

// ───────────── Disponibilité (à la UptimeRobot) ─────────────
//
// La disponibilité est calculée en TEMPS, à partir des pannes confirmées (table outages), et non en
// ratio de contrôles : elle reste exacte quelle que soit la fréquence de contrôle ou la rétention.

export const DAY_MS = 86400e3;

export const openOutage = async (watchId, start, reason, code) =>
  await db.insert('INSERT INTO outages(watch_id, start, reason, code) VALUES(?,?,?,?)', [watchId, start, reason ?? '', code ?? null]);

export async function closeOutage(id, end) {
  await db.run('UPDATE outages SET "end" = ? WHERE id = ? AND "end" IS NULL', [end, id]);
  return await db.get('SELECT * FROM outages WHERE id = ?', [id]);
}

/** Panne en cours du site ({ start, reason }), ou undefined s'il n'y en a pas. */
export const currentOutage = async (watchId) =>
  await db.get('SELECT start, reason FROM outages WHERE watch_id = ? AND "end" IS NULL ORDER BY start DESC LIMIT 1', [watchId]);

/** Fin de la dernière panne terminée (ms), ou null. */
export const lastOutageEnd = async (watchId) => (await db.get('SELECT MAX("end") e FROM outages WHERE watch_id = ?', [watchId])).e ?? null;

export async function upsertDaily(watchId, ts, ok, ms) {
  const hasMs = ok && ms != null;
  await db.run(`
    INSERT INTO daily_stats(watch_id, day, n, ok, sum_ms, ms_n, min_ms, max_ms) VALUES(?,?,1,?,?,?,?,?)
    ON CONFLICT(watch_id, day) DO UPDATE SET
      n = daily_stats.n + 1, ok = daily_stats.ok + excluded.ok, sum_ms = daily_stats.sum_ms + excluded.sum_ms, ms_n = daily_stats.ms_n + excluded.ms_n,
      min_ms = CASE WHEN excluded.min_ms IS NULL THEN daily_stats.min_ms WHEN daily_stats.min_ms IS NULL THEN excluded.min_ms
                    WHEN excluded.min_ms < daily_stats.min_ms THEN excluded.min_ms ELSE daily_stats.min_ms END,
      max_ms = CASE WHEN excluded.max_ms IS NULL THEN daily_stats.max_ms WHEN daily_stats.max_ms IS NULL THEN excluded.max_ms
                    WHEN excluded.max_ms > daily_stats.max_ms THEN excluded.max_ms ELSE daily_stats.max_ms END
  `, [watchId, Math.floor(ts / DAY_MS), ok ? 1 : 0, hasMs ? ms : 0, hasMs ? 1 : 0, hasMs ? ms : null, hasMs ? ms : null]);
}

/** Durée d'indisponibilité (ms) sur [from, to] : somme des recouvrements avec les pannes. */
export async function downtimeBetween(watchId, from, to, now = Date.now()) {
  const rows = await db.all('SELECT start, "end" FROM outages WHERE watch_id = ? AND start < ? AND ("end" IS NULL OR "end" > ?)', [watchId, to, from]);
  let t = 0;
  for (const r of rows) t += Math.max(0, Math.min(r.end ?? now, to) - Math.max(r.start, from));
  return t;
}

/** Disponibilité en % sur [from, to], bornée au début de la surveillance. null = pas assez de recul (< 1 min). */
export async function uptimeBetween(watch, from, to, now = Date.now()) {
  to = Math.min(to, now);
  const start = Math.max(from, watch.createdAt);
  const span = to - start;
  if (span < 60e3) return { uptime: null, downtime: 0, outages: 0 };
  const down = await downtimeBetween(watch.id, start, to, now);
  const outages = (await db.get('SELECT COUNT(*) n FROM outages WHERE watch_id = ? AND start < ? AND ("end" IS NULL OR "end" > ?)', [watch.id, to, start])).n;
  return { uptime: Math.max(0, 100 * (1 - down / span)), downtime: down, outages };
}

export const UPTIME_PERIODS = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 };

export async function uptimeSummary(watch, now = Date.now()) {
  const out = {};
  for (const [k, d] of Object.entries(UPTIME_PERIODS)) out[k] = await uptimeBetween(watch, now - d * DAY_MS, now, now);
  return out;
}

/** 90 jours calendaires (jour local du navigateur, via son décalage UTC en minutes). */
export async function uptimeBars(watch, tzMinutes = 0, now = Date.now(), days = 90) {
  const off = tzMinutes * 60e3;
  const todayStart = Math.floor((now + off) / DAY_MS) * DAY_MS - off;
  const bars = [];
  for (let i = days - 1; i >= 0; i--) {
    const from = todayStart - i * DAY_MS;
    const to = from + DAY_MS;
    const u = to <= watch.createdAt ? { uptime: null, downtime: 0, outages: 0 } : await uptimeBetween(watch, from, to, now);
    bars.push({ from, ...u });
  }
  return bars;
}

export async function outageList(watchId, limit = 50, now = Date.now()) {
  return (await db.all('SELECT id, start, "end", reason, code FROM outages WHERE watch_id = ? ORDER BY start DESC LIMIT ?', [watchId, limit]))
    .map((o) => ({ ...o, duration: (o.end ?? now) - o.start, ongoing: o.end == null }));
}

/** Temps de réponse moyen / min / max sur N jours (détail des contrôles si dispo, agrégats sinon). */
export async function responseStats(watchId, days, now = Date.now()) {
  if (days <= 7) {
    const r = await db.get('SELECT AVG(ms) avg, MIN(ms) min, MAX(ms) max, COUNT(*) n FROM checks WHERE watch_id = ? AND ok = 1 AND ms IS NOT NULL AND ts > ?', [watchId, now - days * DAY_MS]);
    return { avg: r.avg == null ? null : Math.round(r.avg), min: r.min, max: r.max, n: r.n };
  }
  const r = await db.get('SELECT SUM(sum_ms) s, SUM(ms_n) n, MIN(min_ms) min, MAX(max_ms) max FROM daily_stats WHERE watch_id = ? AND day > ?', [watchId, Math.floor(now / DAY_MS) - days]);
  return { avg: r.n ? Math.round(r.s / r.n) : null, min: r.min, max: r.max, n: r.n || 0 };
}

/** Temps de réponse moyen / min / max sur [from, to[ d'après les agrégats journaliers (jours UTC entiers). */
export async function responseBetween(watchId, from, to) {
  const r = await db.get('SELECT SUM(sum_ms) s, SUM(ms_n) n, MIN(min_ms) min, MAX(max_ms) max, SUM(n) checks FROM daily_stats WHERE watch_id = ? AND day >= ? AND day < ?', [watchId, Math.floor(from / DAY_MS), Math.ceil(to / DAY_MS)]);
  return { avg: r.n ? Math.round(r.s / r.n) : null, min: r.min ?? null, max: r.max ?? null, checks: r.checks || 0 };
}

/** Pannes qui recoupent [from, to[, bornées à cette période. */
export async function outagesBetween(watchId, from, to, now = Date.now()) {
  return (await db.all('SELECT id, start, "end", reason, code FROM outages WHERE watch_id = ? AND start < ? AND ("end" IS NULL OR "end" > ?) ORDER BY start', [watchId, to, from]))
    .map((o) => {
      const start = Math.max(o.start, from);
      const end = Math.min(o.end ?? now, to);
      return { ...o, start, end, ongoing: o.end == null && to > now, duration: Math.max(0, end - start), startedBefore: o.start < from };
    });
}

/** Série de points {ts, ms, ok} pour le graphique : brut (24 h), horaire (7 j) ou journalier (30/90 j). */
export async function responseSeries(watchId, range, now = Date.now()) {
  if (range === '24h') {
    return (await db.all('SELECT ts, ok, ms FROM checks WHERE watch_id = ? AND ts > ? ORDER BY ts', [watchId, now - DAY_MS]))
      .map((r) => ({ ts: r.ts, ms: r.ok ? r.ms : null, ok: !!r.ok }));
  }
  if (range === '7d') {
    const buckets = new Map();
    for (const r of await db.all('SELECT ts, ok, ms FROM checks WHERE watch_id = ? AND ts > ? ORDER BY ts', [watchId, now - 7 * DAY_MS])) {
      const k = Math.floor(r.ts / 3600e3);
      const b = buckets.get(k) || { ts: k * 3600e3 + 1800e3, sum: 0, n: 0, ok: true };
      if (r.ok && r.ms != null) { b.sum += r.ms; b.n++; }
      if (!r.ok) b.ok = false;
      buckets.set(k, b);
    }
    return [...buckets.values()].map((b) => ({ ts: b.ts, ms: b.n ? Math.round(b.sum / b.n) : null, ok: b.ok }));
  }
  const days = range === '90d' ? 90 : 30;
  return (await db.all('SELECT day, n, ok, sum_ms, ms_n FROM daily_stats WHERE watch_id = ? AND day > ? ORDER BY day', [watchId, Math.floor(now / DAY_MS) - days]))
    .map((r) => ({ ts: r.day * DAY_MS + DAY_MS / 2, ms: r.ms_n ? Math.round(r.sum_ms / r.ms_n) : null, ok: r.ok === r.n }));
}

export async function prune(watchId) {
  const cutoff = Date.now() - 400 * DAY_MS;
  await db.run('DELETE FROM outages WHERE watch_id = ? AND "end" IS NOT NULL AND "end" < ?', [watchId, cutoff]);
  await db.run('DELETE FROM daily_stats WHERE watch_id = ? AND day < ?', [watchId, Math.floor(cutoff / DAY_MS)]);
  await db.run('DELETE FROM maintenance WHERE watch_id = ? AND "end" < ?', [watchId, Date.now() - 90 * DAY_MS]);
  const { checks, snapshots } = getInstanceSettings().retention;
  await db.run('DELETE FROM checks WHERE watch_id = ? AND id NOT IN (SELECT id FROM checks WHERE watch_id = ? ORDER BY id DESC LIMIT ?)', [watchId, watchId, checks]);
  await db.run('DELETE FROM snapshots WHERE watch_id = ? AND id NOT IN (SELECT id FROM snapshots WHERE watch_id = ? ORDER BY id DESC LIMIT ?)', [watchId, watchId, snapshots]);
}
