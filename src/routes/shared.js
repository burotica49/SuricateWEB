// Fonctions communes aux modules de routes : validation d'un site, résumé pour le tableau de bord, réglages publics.
// Elles reçoivent `ctx` (utilisateur, application) quand elles en ont besoin : rien n'est lu dans l'environnement ici.
import { HttpError } from '../http.js';
import { randomBytes } from 'node:crypto';
import { getSettings, listWatches, getWatch, updateWatch, normalizeConfig, defaultConfig, DEFAULT_KEYWORDS, uptimeBetween, DAY_MS, latestScreenshots, screenshotUsage, getGroup, activeMaintenanceMap, unreadAlertCounts, domainExpiryAlertState, checkStatsSince, sparklines } from '../db.js';
import { isRunning } from '../scheduler.js';
import { cmsConfigError } from '../cms.js';
import { resolvePage } from '../pages.js';
import { engine, chromePath } from '../screenshot.js';
import { parseHtml, selectAll } from '../html.js';
import { clamp, SEV } from '../util.js';

export function normalizeUrl(input) {
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

export function validateConfig(cfg, siteUrl) {
  const cmsErr = cmsConfigError(cfg.cms);
  if (cmsErr) throw new HttpError(400, cmsErr);
  for (const p of cfg.pages) {
    if (!resolvePage(siteUrl, p)) throw new HttpError(400, `Page invalide ou extérieure au site : ${p.url}`);
  }
  for (const r of cfg.ignoreRegex) {
    try {
      new RegExp(r, 'i');
    } catch {
      throw new HttpError(400, `Expression régulière invalide : ${r}`);
    }
  }
}

export const SELECTOR_CHECK = async (cfg) => {
  const dummy = parseHtml('<div></div>');
  for (const s of [cfg.selector, cfg.excludeSelector].filter(Boolean)) {
    try {
      selectAll(dummy, s);
    } catch (e) {
      throw new HttpError(400, e.message);
    }
  }
};

export const RESET_KEYS = ['selector', 'excludeSelector', 'ignoreRegex', 'images'];

/** Même échéance, à deux jours près : un renouvellement (souvent +1 an) ne correspond pas. */

export const sameExpiry = (a, b) => (a == null || b == null ? a == null && b == null : Math.abs(a - b) < 2 * 864e5);

/**
 * Le rappel « le domaine expire bientôt » quitte l'accueil une fois acquitté,
 * tant que l'échéance est la même et qu'elle n'est pas devenue plus grave (30 j → moins de 7).
 * La date reste dans le détail du site.
 */

export function domainExpiryAcked(w, ctx) {
  const cur = w.state.incidents?.rdap_expiring;
  if (!cur) return false;
  const rank = SEV[cur.severity] || 0;
  const expires = w.state.rdap?.expires ?? null;
  const stored = w.state.domainAck?.rdap_expiring;
  if (stored && rank <= (SEV[stored.severity] || 0) && sameExpiry(stored.expires ?? null, expires)) return true;
  const seen = ctx.domainExpiry?.get(w.id);
  return !!(seen && !seen.unread && rank <= seen.max);
}

/** Incidents du CMS (mises à jour, PHP, sécurité) : acquittables, leurs données et alertes restent. */

export const isCmsIncident = (key) => key.startsWith('cms_') || key === 'php_eol';

/** Acquitté tant que l'incident n'est ni plus grave ni plus gros (plus de fichiers ou de comptes) qu'au moment du clic. */

export function cmsIncidentAcked(w, key, i) {
  const stored = w.state.incidentAck?.[key];
  return !!stored && (SEV[i.severity] || 0) <= (SEV[stored.severity] || 0) && (i.count ?? 0) <= (stored.count ?? 0);
}

/** Mémorise l'acquittement sur le site : il survit aux contrôles suivants, même sans alerte non lue. */

export async function rememberDomainAck(id) {
  const w = await getWatch(id);
  if (!w) return;
  const state = { ...w.state };
  const inc = state.incidents?.rdap_expiring;
  if (inc) state.domainAck = { ...(state.domainAck || {}), rdap_expiring: { severity: inc.severity, expires: state.rdap?.expires ?? null } };
  const cms = Object.entries(state.incidents || {}).filter(([k]) => isCmsIncident(k));
  if (cms.length) state.incidentAck = { ...(state.incidentAck || {}), ...Object.fromEntries(cms.map(([k, i]) => [k, { severity: i.severity, count: i.count ?? 0 }])) };
  if (inc || cms.length) await updateWatch(id, { state });
}

export async function summarize(w, ctx) {
  const quietDomain = domainExpiryAcked(w, ctx);
  const incidents = Object.entries(w.state.incidents || {}).map(([key, i]) => ({ key, ...i, ...((key === 'rdap_expiring' && quietDomain) || (isCmsIncident(key) && cmsIncidentAcked(w, key, i)) ? { acked: true } : {}) }));
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
    uptime: domainOnly ? null : (await uptimeBetween(w, now - DAY_MS, now, now)).uptime,
    uptime30: domainOnly ? null : (await uptimeBetween(w, now - 30 * DAY_MS, now, now)).uptime,
    tlsExpires: w.state.tls?.expires || null, domainExpires: w.state.rdap?.expires || null,
    maintenanceUntil: ctx.maint?.get(w.id)?.end ?? null,
  };
}

export async function buildCtx() {
  // Dernière alerte d'échéance déjà émise (domainExpiry) : sert à la retirer de l'accueil une fois lue.
  const stats = await checkStatsSince(Date.now() - 864e5);
  for (const [id, spark] of Object.entries(await sparklines(40))) (stats[id] ||= {}).spark = spark;
  return { unread: await unreadAlertCounts(), stats, shots: await latestScreenshots(), domainExpiry: await domainExpiryAlertState(), maint: await activeMaintenanceMap() };
}

export const alertRow = (r) => ({
  id: r.id, watchId: r.watch_id, watchName: r.watch_name, ts: r.ts, severity: r.severity, type: r.type, title: r.title,
  detail: r.detail, snapshotId: r.snapshot_id, prevSnapshotId: r.prev_snapshot_id, read: !!r.read, notified: !!r.notified, notifyError: r.notify_error, maintenance: r.maintenance > 0,
});

export const maskToken = (t) => (t ? t.slice(0, 4) + '••••••••' + t.slice(-4) : '');

/** Réglages tels que l'interface les voit (jeton Telegram masqué). `ctx` apporte l'utilisateur connecté et les infos de l'application. */
export async function publicSettings(ctx) {
  const s = getSettings();
  return {
    telegram: { ...s.telegram, token: '', tokenSet: !!s.telegram.token, tokenMasked: maskToken(s.telegram.token) },
    baseUrl: s.baseUrl, defaultInterval: s.defaultInterval, userAgent: s.userAgent, builtinKeywords: s.builtinKeywords,
    retention: s.retention, cmsAfterDays: s.cmsAfterDays, authUser: ctx.user?.name ?? '', defaultKeywords: DEFAULT_KEYWORDS,
    screenshots: { available: engine.available(), browser: chromePath(), usage: await screenshotUsage() },
    app: ctx.app.info,
  };
}

/**
 * Valide et normalise les données d'un site. `limits` : plafonds du forfait (ctx.limits()) — { minIntervalMin } :
 * un intervalle plus court est ramené au minimum autorisé, jamais refusé.
 */
export async function watchInput(body, existing, limits = {}) {
  const s = getSettings();
  const cfg = normalizeConfig({ ...(existing?.config || defaultConfig()), ...(body.config || {}), checks: { ...(existing?.config.checks || {}), ...(body.config?.checks || {}) } });
  if (cfg.cms.type && !cfg.cms.token) cfg.cms.token = randomBytes(32).toString('base64url');
  const url = body.url !== undefined ? normalizeUrl(body.url) : existing.url;
  validateConfig(cfg, url);
  // Adresse de la page de statut : un jeton aléatoire, propre à ce site (jamais deux sites avec le même).
  const st = cfg.statusPage;
  if (st.enabled && !st.token) st.token = randomBytes(18).toString('base64url');
  if (st.token && (await listWatches()).some((o) => o.id !== existing?.id && o.config.statusPage.token === st.token)) st.token = randomBytes(18).toString('base64url');
  const tags = Array.isArray(body.tags) ? [...new Set(body.tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 10) : existing?.tags || [];
  // Groupe : absent = inchangé ; null / '' = « Sans groupe » ; sinon il doit exister.
  let groupId = existing?.groupId ?? null;
  if (body.groupId !== undefined) {
    if (body.groupId === null || body.groupId === '') groupId = null;
    else if (await getGroup(Number(body.groupId))) groupId = Number(body.groupId);
    else throw new HttpError(400, 'Groupe inconnu');
  }
  return {
    cfg,
    data: {
      groupId,
      url,
      name: String(body.name ?? existing?.name ?? '').trim() || new URL(url).hostname.replace(/^www\./, ''),
      interval: clamp(body.interval ?? existing?.interval ?? s.defaultInterval, Math.max(1, limits.minIntervalMin ?? 1), 10080, Math.max(15, limits.minIntervalMin ?? 1)),
      tags,
      enabled: body.enabled !== undefined ? !!body.enabled : existing?.enabled ?? true,
      config: cfg,
    },
  };
}

export const loadWatch = async (ctx) => {
  const w = await getWatch(Number(ctx.params.id));
  if (!w) throw new HttpError(404, 'Site introuvable');
  return w;
};
