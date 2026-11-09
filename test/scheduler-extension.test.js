// Planificateur : la version hébergée choisit QUELS sites contrôler à chaque passage (équité entre comptes, intervalles par forfait).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'suricate-sched-'));
process.env.CHROME_PATH = '/nonexistent/chrome';

const dbm = await import('../src/db.js');
const { startScheduler, isRunning } = await import('../src/scheduler.js');
const { configureExtensions, resetExtensions } = await import('../src/extensions.js');

const NO_NET = { checks: { dns: false, tls: false, rdap: false }, screenshot: { enabled: false } };
const mk = (name) => dbm.createWatch({ name, url: 'http://127.0.0.1:9/', interval: 60, config: NO_NET });
const until = async (cond, ms = 5000) => { const t = Date.now(); while (!(await cond())) { if (Date.now() - t > ms) throw new Error('délai dépassé'); await new Promise((r) => setTimeout(r, 25)); } };

test('pickDue : seuls les sites choisis par l\'extension sont contrôlés', async () => {
  const a = await mk('Non choisi');
  const b = await mk('Choisi');
  const asked = [];
  configureExtensions({ scheduler: { pickDue: (now, limit) => { asked.push(limit); return [b.id]; } } });
  const timer = startScheduler();
  try {
    await until(async () => (await dbm.getWatch(b.id)).lastCheck);
    await until(() => !isRunning(b.id));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await dbm.getWatch(a.id)).lastCheck, null, 'le site non choisi n\'a pas été contrôlé');
    assert.equal(asked[0], 100, 'le planificateur demande au plus 100 sites par passage');
  } finally {
    clearInterval(timer);
    resetExtensions();
  }
});

test('pickDue en échec : le planificateur continue (journalisé, pas de plantage)', async () => {
  const origError = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(' '));
  let calls = 0;
  configureExtensions({ scheduler: { pickDue: async () => { calls++; throw new Error('base indisponible'); } } });
  const timer = startScheduler();
  try {
    await until(() => calls >= 1);
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(logged.some((l) => /planificateur/.test(l) && /base indisponible|Error/.test(l + ' ')), logged.join('|'));
  } finally {
    clearInterval(timer);
    console.error = origError;
    resetExtensions();
  }
});

test.after(() => dbm.db.close());
