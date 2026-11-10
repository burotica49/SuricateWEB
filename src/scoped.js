// Accès aux données LIMITÉ à un compte : c'est ce que reçoivent les routes (ctx.data).
//
// Règle de la version multi-comptes : un compte ne voit, ne modifie et ne supprime que ses propres sites et groupes, et ce qui en
// dépend (contrôles, alertes, captures, versions, pannes, maintenances). Une ressource d'un autre compte est traitée comme si elle
// n'existait pas : réponse « introuvable » (404), jamais « interdit », pour ne rien révéler de son existence.
//
// ACCÈS LIMITÉ (version hébergée : invité par groupe ou par site) : `scopedData(accountId, { groupIds, siteIds })` ne montre, parmi les sites du
// compte, que ceux de ces groupes ou de cette liste. Tout le reste est « introuvable » comme chez un autre compte ; les écritures de structure
// (création, groupes, disposition) sont refusées ici même, en plus du droit que `authorize` refuse déjà (défense en profondeur).
//
// Les routes n'importent donc PAS directement les fonctions de db.js qui lisent ou écrivent par identifiant ou par liste
// (listWatches, getWatch, getGroup, getSnapshot…) : elles passent par ctx.data. Un test (test/account-isolation.test.js) le vérifie.
// Les fonctions d'un site DÉJÀ obtenu par ctx.data (recentChecks(w.id), listMaintenance(w.id)…) restent sûres : son appartenance
// a été contrôlée.
import {
  listWatches, getWatch, createWatch, listGroups, getGroup, createGroup, updateGroup, deleteGroup, applyLayout,
  getSnapshot, getScreenshot, getMaintenance, endMaintenance, queryAlerts, markEveryAlertRead, markAlertsRead, markWatchesAlertsRead,
  unreadAlertCounts, domainExpiryAlertState, checkStatsSince, sparklines, latestScreenshots, activeMaintenanceMap, screenshotUsage,
} from './db.js';
import { HttpError } from './http.js';

export function scopedData(accountId, access = null) {
  if (!Number.isInteger(accountId) || accountId < 1) throw new Error(`Identifiant de compte invalide : ${accountId}`);
  const restricted = access != null;
  const groupIds = new Set((access?.groupIds ?? []).map(Number));
  const siteIds = new Set((access?.siteIds ?? []).map(Number));
  /** Ce site est-il dans le périmètre partagé ? (toujours vrai sans accès limité) */
  const inScope = (w) => !restricted || siteIds.has(w.id) || (w.groupId != null && groupIds.has(w.groupId));
  const deny = () => { throw new HttpError(403, 'Accès refusé'); };

  /** Le site, s'il est à ce compte (et dans le périmètre partagé) ; sinon null. */
  const watch = async (id) => {
    const w = await getWatch(id);
    return w && w.accountId === accountId && inScope(w) ? w : null;
  };
  const visibleWatches = async () => (await listWatches(accountId)).filter(inScope);
  /** Identifiants des sites visibles : null sans accès limité (tout le compte). */
  const visibleIds = async () => (restricted ? (await visibleWatches()).map((w) => w.id) : null);
  /** Un groupe est visible s'il est partagé, ou s'il contient un site partagé (l'interface range les sites par groupe). */
  const groupVisible = async (g) => !restricted || groupIds.has(g.id) || (await visibleWatches()).some((w) => w.groupId === g.id);
  const group = async (id) => {
    const g = await getGroup(id);
    return g && g.accountId === accountId && (await groupVisible(g)) ? g : null;
  };
  /** La ligne d'une ressource qui dépend d'un site (version, capture, maintenance), si le site est visible. */
  const ofOwnWatch = async (row, watchId) => (row && (await watch(watchId)) ? row : null);
  /** Objet ou Map indexé par identifiant de site : ne garde que les sites visibles. */
  const onlyVisible = async (data) => {
    const ids = await visibleIds();
    if (!ids) return data;
    const keep = new Set(ids);
    if (data instanceof Map) return new Map([...data].filter(([k]) => keep.has(Number(k))));
    return Object.fromEntries(Object.entries(data).filter(([k]) => keep.has(Number(k))));
  };

  return {
    accountId,
    /** Vrai pour un accès limité à quelques groupes ou sites (invité) : l'interface et les flux temps réel en tiennent compte. */
    restricted,

    // ── sites ──
    getWatch: watch,
    /** Comme getWatch, mais lève 404 « Site introuvable » : pour les routes. */
    requireWatch: async (id, message = 'Site introuvable') => {
      const w = await watch(id);
      if (!w) throw new HttpError(404, message);
      return w;
    },
    listWatches: visibleWatches,
    createWatch: (data) => (restricted ? deny() : createWatch({ ...data, accountId })),

    // ── groupes ──
    getGroup: group,
    listGroups: async () => {
      const all = await listGroups(accountId);
      if (!restricted) return all;
      const visible = new Set((await visibleWatches()).map((w) => w.groupId).filter((g) => g != null));
      return all.filter((g) => groupIds.has(g.id) || visible.has(g.id));
    },
    createGroup: (data) => (restricted ? deny() : createGroup({ ...data, accountId })),
    updateGroup: async (id, patch) => (restricted ? deny() : (await group(id)) ? updateGroup(id, patch) : null),
    deleteGroup: async (id) => (restricted ? deny() : (await group(id)) ? deleteGroup(id) : false),
    applyLayout: (layout) => (restricted ? deny() : applyLayout(layout, accountId)),

    // ── ce qui dépend d'un site : on remonte au site pour contrôler son compte ──
    getSnapshot: async (id) => { const s = await getSnapshot(id); return ofOwnWatch(s, s?.watch_id); },
    getScreenshot: async (id) => { const s = await getScreenshot(id); return ofOwnWatch(s, s?.watch_id); },
    /** Termine ou supprime une fenêtre de maintenance, seulement si son site est à ce compte. Retourne la fenêtre, ou null. */
    endMaintenance: async (id) => {
      const m = await getMaintenance(id);
      return m && (await watch(m.watchId)) ? endMaintenance(id) : null;
    },

    // ── alertes ──
    queryAlerts: async (filters = {}) => queryAlerts({ ...filters, accountId, ...(restricted ? { watchIds: await visibleIds() } : {}) }),
    markEveryAlertRead: async () => (restricted ? markWatchesAlertsRead(await visibleIds()) : markEveryAlertRead(accountId)),
    markAlertsRead: async (ids) => markAlertsRead(ids, accountId, restricted ? await visibleIds() : null),

    // ── tableau de bord : indexés par site, on ne garde que les sites visibles ──
    unreadAlertCounts: async () => onlyVisible(await unreadAlertCounts(accountId)),
    domainExpiryAlertState: async () => onlyVisible(await domainExpiryAlertState(accountId)),
    checkStatsSince: async (since) => onlyVisible(await checkStatsSince(since, accountId)),
    sparklines: async (limit) => onlyVisible(await sparklines(limit, accountId)),
    latestScreenshots: async () => onlyVisible(await latestScreenshots(accountId)),
    activeMaintenanceMap: async (now) => onlyVisible(await activeMaintenanceMap(now, accountId)),
    // Espace disque des captures : un chiffre du compte entier, que l'invité n'a pas à connaître.
    screenshotUsage: async () => (restricted ? { count: 0, bytes: 0 } : screenshotUsage(accountId)),
  };
}
