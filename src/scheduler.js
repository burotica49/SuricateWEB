import { db, normalizeConfig } from './db.js';
import { runCheck } from './checker.js';
import { captureWatch, isCapturing, engine } from './screenshot.js';
import { bus } from './events.js';

const CONCURRENCY = 5;
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
  while (active < CONCURRENCY && queue.length) {
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
  const tick = () => {
    const due = db.prepare('SELECT id FROM watches WHERE enabled = 1 AND next_run <= ? ORDER BY next_run LIMIT 100').all(Date.now());
    for (const { id } of due) {
      if (!running.has(id)) enqueue(id);
    }
    // Captures d'écran : planifiées à part, selon leur propre fréquence (la file interne limite la charge de Chrome).
    if (!engine.available()) return;
    for (const { id, config } of db.prepare('SELECT id, config FROM watches WHERE enabled = 1 AND next_shot <= ?').all(Date.now())) {
      let cfg;
      try {
        cfg = normalizeConfig(JSON.parse(config));
      } catch {
        continue;
      }
      if (cfg.mode === 'domain' || !cfg.screenshot.enabled || isCapturing(id)) continue;
      captureWatch(id); // ne lève jamais : l'erreur est enregistrée sur le site
    }
  };
  tick();
  return setInterval(tick, 5000);
}
