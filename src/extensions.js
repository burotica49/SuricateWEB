// Points d'extension du cœur qui vivent hors du serveur HTTP : notifications et planificateur.
// (Ceux du serveur — authentification, droits, quotas, routes — se passent à createApp, voir src/app.js.)
//
// Un seul jeu d'extensions par processus : le planificateur et les contrôles sont eux-mêmes uniques dans le processus.
import { defaultNotifier } from './notify.js';
import { dueWatchIds } from './db.js';

const defaults = () => ({
  /** { resolveChannels(watch, alerts, settings) → canaux } — voir src/notify.js. */
  notifier: defaultNotifier,
  /**
   * Planificateur. `concurrency` : contrôles simultanés. `pickDue(now, limit)` : identifiants des sites à contrôler,
   * dans l'ordre voulu (la version hébergée y met l'équité entre comptes et les intervalles minimaux par forfait).
   */
  scheduler: { concurrency: 5, pickDue: (now, limit) => dueWatchIds(now, limit) },
});

let current = defaults();

export const getExtensions = () => current;

export function configureExtensions({ notifier, scheduler } = {}) {
  if (notifier && typeof notifier.resolveChannels !== 'function') throw new Error('notifier.resolveChannels doit être une fonction');
  current = {
    notifier: notifier ?? current.notifier,
    scheduler: { ...current.scheduler, ...(scheduler ?? {}) },
  };
}

/** Remet les valeurs d'origine (tests). */
export const resetExtensions = () => {
  current = defaults();
};
