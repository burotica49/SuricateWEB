import { dueCmsWatches, dueShotWatches } from './db.js';
import { getExtensions } from './extensions.js';
import { runCheck } from './checker.js';
import { captureWatch, isCapturing, engine } from './screenshot.js';
import { pollCms } from './cms.js';
import { bus } from './events.js';

const running = new Set();
const queue = [];

/**
 * Mode démo (VIGIE_DEMO=1) : l'instance affiche des données fictives (captures d'écran de la documentation, essai à blanc).
 * Aucun contrôle ni capture ne part sur le réseau, et rien ne vient modifier les données de démonstration.
 */
export const DEMO = process.env.VIGIE_DEMO === '1';
export const DEMO_MESSAGE = 'Mode démo : les contrôles sont désactivés (données fictives).';

/** Lance un contrôle (immédiat ou en file). Un même site n'est jamais contrôlé deux fois en parallèle. */
export function enqueue(id, { wait = false } = {}) {
  if (DEMO) return wait ? Promise.resolve({ error: DEMO_MESSAGE, alerts: [] }) : null;
  if (running.has(id)) return wait ? Promise.resolve(null) : null;
  return new Promise((resolve) => {
    queue.push({ id, resolve });
    running.add(id);
    pump();
  }).then((r) => (wait ? r : undefined));
}

let active = 0;
function pump() {
  while (active < getExtensions().scheduler.concurrency && queue.length) {
    const job = queue.shift();
    active++;
    bus.emit('event', { type: 'running', watchId: job.id });
    runCheck(job.id)
      .then(job.resolve, (e) => {
        console.error(`[check ${job.id}]`, e);
        job.resolve({ error: e.message });
      })
      .finally(() => {
        running.delete(job.id);
        active--;
        bus.emit('event', { type: 'idle', watchId: job.id });
        pump();
      });
  }
}

export const isRunning = (id) => running.has(id);

export function startScheduler() {
  if (DEMO) return null;
  // Un passage qui dure plus de 5 s (base lente) ne doit pas être doublé par le suivant : il lancerait deux fois les mêmes contrôles.
  let ticking = false;
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      for (const id of await getExtensions().scheduler.pickDue(Date.now(), 100)) {
        if (!running.has(id)) enqueue(id);
      }
      // Relevés CMS : fréquence propre (souvent 12 h), deux à la fois pour ne pas ouvrir toutes les boutiques d'un coup.
      let cmsSlots = 2;
      for (const { id, config: cfg } of await dueCmsWatches(Date.now())) {
        if (cmsSlots <= 0) break;
        if (cfg.mode === 'domain' || (cfg.cms.type !== 'wordpress' && cfg.cms.type !== 'prestashop')) continue;
        cmsSlots--;
        pollCms(id).catch((e) => console.error(`[cms ${id}]`, e));
      }
      // Captures d'écran : planifiées à part, selon leur propre fréquence (la file interne limite la charge de Chrome).
      if (!engine.available()) return;
      for (const { id, config: cfg } of await dueShotWatches(Date.now())) {
        if (cfg.mode === 'domain' || !cfg.screenshot.enabled || isCapturing(id)) continue;
        captureWatch(id); // ne lève jamais : l'erreur est enregistrée sur le site
      }
    } catch (e) {
      // Une erreur de base ne doit pas arrêter la surveillance : le passage suivant réessaie.
      console.error('[planificateur]', e);
    } finally {
      ticking = false;
    }
  };
  tick();
  return setInterval(tick, 5000);
}
