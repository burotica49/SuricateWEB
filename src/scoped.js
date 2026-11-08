// Accès aux données LIMITÉ à un compte : c'est ce que reçoivent les routes (ctx.data).
//
// Règle de la version multi-comptes : un compte ne voit, ne modifie et ne supprime que ses propres sites et groupes, et ce qui en
// dépend (contrôles, alertes, captures, versions, pannes, maintenances). Une ressource d'un autre compte est traitée comme si elle
// n'existait pas : réponse « introuvable » (404), jamais « interdit », pour ne rien révéler de son existence.
//
// Les routes n'importent donc PAS directement les fonctions de db.js qui lisent ou écrivent par identifiant ou par liste
// (listWatches, getWatch, getGroup, getSnapshot…) : elles passent par ctx.data. Un test (test/account-isolation.test.js) le vérifie.
// Les fonctions d'un site DÉJÀ obtenu par ctx.data (recentChecks(w.id), listMaintenance(w.id)…) restent sûres : son appartenance
// a été contrôlée.
import {
  listWatches, getWatch, createWatch, listGroups, getGroup, createGroup, updateGroup, deleteGroup, applyLayout,
  getSnapshot, getScreenshot, getMaintenance, endMaintenance, queryAlerts, markEveryAlertRead, markAlertsRead,
  unreadAlertCounts, domainExpiryAlertState, checkStatsSince, sparklines, latestScreenshots, activeMaintenanceMap, screenshotUsage,
} from './db.js';
import { HttpError } from './http.js';

export function scopedData(accountId) {
  if (!Number.isInteger(accountId) || accountId < 1) throw new Error(`Identifiant de compte invalide : ${accountId}`);

  /** Le site, s'il est à ce compte ; sinon null. */
  const watch = async (id) => {
    const w = await getWatch(id);
    return w && w.accountId === accountId ? w : null;
  };
  const group = async (id) => {
    const g = await getGroup(id);
    return g && g.accountId === accountId ? g : null;
  };
  /** La ligne d'une ressource qui dépend d'un site (version, capture, maintenance), si le site est à ce compte. */
  const ofOwnWatch = async (row, watchId) => (row && (await watch(watchId)) ? row : null);

  return {
    accountId,

    // ── sites ──
    getWatch: watch,
    /** Comme getWatch, mais lève 404 « Site introuvable » : pour les routes. */
    requireWatch: async (id, message = 'Site introuvable') => {
      const w = await watch(id);
      if (!w) throw new HttpError(404, message);
      return w;
    },
    listWatches: () => listWatches(accountId),
    createWatch: (data) => createWatch({ ...data, accountId }),

    // ── groupes ──
    getGroup: group,
    listGroups: () => listGroups(accountId),
    createGroup: (data) => createGroup({ ...data, accountId }),
    updateGroup: async (id, patch) => ((await group(id)) ? updateGroup(id, patch) : null),
    deleteGroup: async (id) => ((await group(id)) ? deleteGroup(id) : false),
    applyLayout: (layout) => applyLayout(layout, accountId),

    // ── ce qui dépend d'un site : on remonte au site pour contrôler son compte ──
    getSnapshot: async (id) => { const s = await getSnapshot(id); return ofOwnWatch(s, s?.watch_id); },
    getScreenshot: async (id) => { const s = await getScreenshot(id); return ofOwnWatch(s, s?.watch_id); },
    /** Termine ou supprime une fenêtre de maintenance, seulement si son site est à ce compte. Retourne la fenêtre, ou null. */
    endMaintenance: async (id) => {
      const m = await getMaintenance(id);
      return m && (await watch(m.watchId)) ? endMaintenance(id) : null;
    },

    // ── alertes ──
    queryAlerts: (filters = {}) => queryAlerts({ ...filters, accountId }),
    markEveryAlertRead: () => markEveryAlertRead(accountId),
    markAlertsRead: (ids) => markAlertsRead(ids, accountId),

    // ── tableau de bord ──
    unreadAlertCounts: () => unreadAlertCounts(accountId),
    domainExpiryAlertState: () => domainExpiryAlertState(accountId),
    checkStatsSince: (since) => checkStatsSince(since, accountId),
    sparklines: (limit) => sparklines(limit, accountId),
    latestScreenshots: () => latestScreenshots(accountId),
    activeMaintenanceMap: (now) => activeMaintenanceMap(now, accountId),
    screenshotUsage: () => screenshotUsage(accountId),
  };
}
