// Points d'extension du cœur qui vivent hors du serveur HTTP : notifications et planificateur.
// (Ceux du serveur — authentification, droits, quotas, routes — se passent à createApp, voir src/app.js.)
//
// Un seul jeu d'extensions par processus : le planificateur et les contrôles sont eux-mêmes uniques dans le processus.
import { defaultNotifier } from './notify.js';
import { createNetGuard } from './net-guard.js';
import { dueWatchIds } from './db.js';

const defaults = () => ({
  /** { resolveChannels(watch, alerts, settings) → canaux } — voir src/notify.js. */
  notifier: defaultNotifier,
  /**
   * Planificateur. `concurrency` : contrôles simultanés. `pickDue(now, limit)` : identifiants des sites à contrôler,
   * dans l'ordre voulu (la version hébergée y met l'équité entre comptes et les intervalles minimaux par forfait).
   */
  scheduler: { concurrency: 5, pickDue: (now, limit) => dueWatchIds(now, limit) },
  /** Garde réseau (src/net-guard.js) : inerte par défaut ; la version hébergée l'active (refus des adresses privées, DNS rebinding). */
  netGuard: createNetGuard({ enabled: false }),
  /**
   * Quotas du forfait (même objet que l'option `entitlements` de createApp). Le cœur le consulte aussi HORS requête : les captures planifiées
   * ou d'alerte n'ont pas de `ctx`, juste un compte. Défaut : aucune limite.
   */
  entitlements: { check: () => {}, limits: () => ({}) },
});

let current = defaults();

export const getExtensions = () => current;

export function configureExtensions({ notifier, scheduler, netGuard, entitlements } = {}) {
  if (notifier && typeof notifier.resolveChannels !== 'function') throw new Error('notifier.resolveChannels doit être une fonction');
  if (netGuard && typeof netGuard.fetch !== 'function') throw new Error('netGuard doit venir de createNetGuard()');
  current = {
    notifier: notifier ?? current.notifier,
    scheduler: { ...current.scheduler, ...(scheduler ?? {}) },
    netGuard: netGuard ?? current.netGuard,
    entitlements: entitlements ?? current.entitlements,
  };
}

/** Remet les valeurs d'origine (tests). */
export const resetExtensions = () => {
  current = defaults();
};
