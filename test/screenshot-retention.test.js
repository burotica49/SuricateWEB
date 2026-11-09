import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Même dossier de données pour ce processus et pour le serveur lancé plus bas.
const dataDir = mkdtempSync(join(tmpdir(), 'suricate-ret-'));
process.env.DATA_DIR = dataDir;
const dbm = await import('../src/db.js');
const shots = await import('../src/screenshot.js');
const { startServer } = await import('../test-support/server.js');
const { openPage, findChrome } = await import('../test-support/browser.js');

// Le serveur démarre AVANT tout test : les tests s'exécutent dès qu'ils sont déclarés, et le serveur met ses réglages en cache
// au démarrage (sans cela, il pourrait lire un réglage qu'un test vient de modifier).
const srv = await startServer({ dataDir, env: { SURICATE_DEMO: '1', CHROME_PATH: findChrome() || '/nonexistent/chrome' } });
test.after(async () => { await srv.stop(); dbm.db.close(); });

/** Insère n captures (lignes + vrais fichiers) sans passer par Chrome. */
let clock = Date.now() - 1e6;
async function addShots(watchId, kind, n, size = 1000) {
  mkdirSync(join(dbm.SHOTS_DIR, String(watchId)), { recursive: true });
  const ids = [];
  for (let i = 0; i < n; i++) {
    const ts = ++clock;
    const file = `${watchId}/${ts}.jpg`;
    const thumb = `${watchId}/${ts}.t.jpg`;
    writeFileSync(join(dbm.SHOTS_DIR, file), Buffer.alloc(size));
    writeFileSync(join(dbm.SHOTS_DIR, thumb), Buffer.alloc(10));
    ids.push(await dbm.insertScreenshot({ watchId, ts, kind, file, thumb, size, width: 1280, height: 800 }));
  }
  return ids;
}
const noNet = { checks: { dns: false, tls: false, rdap: false } };
const mk = async (name, screenshot = {}) => await dbm.createWatch({ name, url: 'https://ret.test/', interval: 5, config: { ...noNet, screenshot } });
const kinds = async (id) => (await dbm.listScreenshots(id, 500)).reduce((a, r) => ({ ...a, [r.kind]: (a[r.kind] || 0) + 1 }), {});

test('configuration : limite 0 = réglage général, valeurs bornées', () => {
  const keep = (v) => dbm.normalizeConfig({ screenshot: { keep: v } }).screenshot.keep;
  assert.equal(dbm.normalizeConfig({}).screenshot.keep, 0, 'par défaut : réglage général');
  assert.deepEqual([keep(0), keep(''), keep(null), keep('abc'), keep(undefined)], [0, 0, 0, 0, 0]);
  assert.equal(keep(24), 24);
  assert.equal(keep('72'), 72, 'valeur reçue en texte');
  assert.equal(keep(5.6), 6);
  assert.equal(keep(-3), 1, 'au moins 1');
  assert.equal(keep(999999), dbm.MAX_KEEP, 'plafonnée');
  assert.equal(dbm.MAX_KEEP, 2000);
});

test('limites : réglage du site, sinon réglage général ; quota des manuelles = même nombre, au plus 100', async () => {
  await dbm.saveSettings({ retention: { screenshots: 168 } });
  assert.deepEqual(shots.shotLimits(await mk('Général'), await dbm.settingsFor(1)), { keep: 168, keepOther: 100 });
  assert.deepEqual(shots.shotLimits(await mk('Propre', { keep: 24 }), await dbm.settingsFor(1)), { keep: 24, keepOther: 24 });
  assert.deepEqual(shots.shotLimits(await mk('Grand', { keep: 1000 }), await dbm.settingsFor(1)), { keep: 1000, keepOther: 100 });
  await dbm.saveSettings({ retention: { screenshots: 50 } });
  assert.deepEqual(shots.shotLimits(await mk('Autre général'), await dbm.settingsFor(1)), { keep: 50, keepOther: 50 }, 'le réglage général suit');
  assert.deepEqual(shots.shotLimits(await mk('Propre 2', { keep: 24 }), await dbm.settingsFor(1)), { keep: 24, keepOther: 24 }, 'le réglage du site l’emporte');
  await dbm.saveSettings({ retention: { screenshots: 168 } });
});

test('suppression : les plus anciennes disparaissent (lignes et fichiers), chaque catégorie a son quota', async () => {
  const w = await mk('Purge', { keep: 4 });
  const sched = await addShots(w.id, 'scheduled', 10);
  const manual = await addShots(w.id, 'manual', 6);
  const alertShots = await addShots(w.id, 'alert', 2);
  // 10 planifiées pour 4 permises = 6 en trop ; 8 manuelles + d'alerte (quota commun) pour 4 permises = 4 en trop.
  assert.equal(await shots.pruneWatchShots(w.id), 6 + 4);
  const rows = await dbm.listScreenshots(w.id, 500);
  assert.deepEqual(rows.filter((r) => r.kind === 'scheduled').map((r) => r.id), sched.slice(-4).reverse(), 'les 4 plus récentes planifiées');
  assert.equal(rows.filter((r) => r.kind !== 'scheduled').length, 4, 'quota des manuelles et d’alerte : 4 au total');
  assert.ok(rows.some((r) => r.id === alertShots.at(-1)), 'la plus récente capture d’alerte est conservée');
  assert.equal((await shots.shotFiles(w.id)).length, 8 * 2, '8 captures × (image + miniature) : les autres sont effacées du disque');
  assert.equal(existsSync(join(dbm.SHOTS_DIR, String(w.id), `${await dbm.getScreenshot(sched[0])?.ts}.jpg`)), false);
  assert.equal(await shots.pruneWatchShots(w.id), 0, 'rien de plus à supprimer');
  assert.deepEqual(manual.length + alertShots.length, 8);
});

test('suppression : abaisser le réglage général s’applique à tous les sites qui le suivent', async () => {
  await dbm.saveSettings({ retention: { screenshots: 100 } });
  const a = await mk('Suit A');
  const b = await mk('Suit B');
  const own = await mk('Garde la sienne', { keep: 30 });
  for (const w of [a, b, own]) await addShots(w.id, 'scheduled', 20);
  await dbm.saveSettings({ retention: { screenshots: 5 } });
  await shots.pruneAllShots();
  assert.equal((await kinds(a.id)).scheduled, 5);
  assert.equal((await kinds(b.id)).scheduled, 5);
  assert.equal((await kinds(own.id)).scheduled, 20, 'sa propre limite (30) n’est pas dépassée : rien de supprimé');
  await dbm.saveSettings({ retention: { screenshots: 168 } });
});

test('statistiques : nombre et poids, par site et au total', async () => {
  const w = await mk('Poids');
  await addShots(w.id, 'scheduled', 3, 2000);
  await addShots(w.id, 'manual', 1, 500);
  assert.deepEqual({ ...(await dbm.screenshotStats(w.id)) }, { count: 4, bytes: 6500 });
  assert.deepEqual({ ...(await dbm.screenshotStats(99999)) }, { count: 0, bytes: 0 });
  assert.ok((await dbm.screenshotUsage()).count >= 4);
});

// ───────────── API et interface ─────────────

test('API : limites et compteurs exposés ; abaisser la limite supprime aussitôt ; changer la limite ne recapture pas', async () => {
  const id = (await srv.post('/api/watches', { url: 'http://127.0.0.1:9/', name: 'Via API', interval: 15 })).json.id;
  await addShots(id, 'scheduled', 12, 1000);
  let r = (await srv.get(`/api/watches/${id}/screenshots`)).json;
  assert.deepEqual([r.keep, r.keepOther, r.count, r.bytes], [168, 100, 12, 12000], 'réglage général, compteurs');

  const cfg = (await srv.get(`/api/watches/${id}`)).json.config;
  const save = (screenshot) => srv.put(`/api/watches/${id}`, { url: 'http://127.0.0.1:9/', name: 'Via API', interval: 15, config: { ...cfg, screenshot: { ...cfg.screenshot, ...screenshot } } });
  await dbm.setShotState(id, { nextShot: 4242424242000 });

  assert.equal((await save({ keep: 5 })).status, 200);
  r = (await srv.get(`/api/watches/${id}/screenshots`)).json;
  assert.deepEqual([r.keep, r.keepOther, r.count], [5, 5, 5], 'limite abaissée : appliquée tout de suite');
  assert.equal(r.nextShot, 4242424242000, 'seule la limite a changé : pas de nouvelle capture demandée');

  await save({ keep: 5, interval: 30 });
  assert.equal((await srv.get(`/api/watches/${id}/screenshots`)).json.nextShot, 0, 'un vrai changement de capture, lui, en redemande une');

  assert.equal((await save({ keep: 0 })).status, 200);
  assert.equal((await srv.get(`/api/watches/${id}/screenshots`)).json.keep, 168, 'retour au réglage général');
  assert.equal((await save({ keep: 99999 })).status, 200);
  assert.equal((await srv.get(`/api/watches/${id}/screenshots`)).json.keep, 2000, 'plafond');
});

test('API réglages : limite générale bornée, appliquée à tous les sites, usage exposé', async () => {
  const id = (await srv.post('/api/watches', { url: 'http://127.0.0.1:9/', name: 'Suit le général', interval: 15 })).json.id;
  await addShots(id, 'scheduled', 9);
  const s = (await srv.get('/api/settings')).json;
  assert.equal(s.retention.screenshots, 168);
  assert.ok(s.screenshots.usage.count >= 9 && s.screenshots.usage.bytes >= 9000);

  assert.equal((await srv.put('/api/settings', { retention: { screenshots: 4 } })).json.retention.screenshots, 4);
  assert.equal((await srv.get(`/api/watches/${id}/screenshots`)).json.count, 4, 'appliquée tout de suite');
  assert.equal((await srv.put('/api/settings', { retention: { screenshots: 0 } })).json.retention.screenshots, 1, 'au moins 1');
  assert.equal((await srv.put('/api/settings', { retention: { screenshots: 'abc' } })).json.retention.screenshots, 168, 'valeur invalide : retour au défaut');
  assert.equal((await srv.put('/api/settings', { retention: { screenshots: 5000 } })).json.retention.screenshots, 2000);
  assert.equal((await srv.put('/api/settings', { retention: { screenshots: 168 } })).json.retention.screenshots, 168);
  srv.logout();
  assert.equal((await srv.put('/api/settings', { retention: { screenshots: 1 } })).status, 401);
  assert.equal(await srv.login(), 200);
});

test('interface : champ « Captures à conserver », durée couverte, compteur de l’onglet Captures', { skip: !findChrome() && 'Chrome/Chromium introuvable', timeout: 90000 }, async () => {
  const id = (await srv.post('/api/watches', { url: 'http://127.0.0.1:9/', name: 'Interface', interval: 15 })).json.id;
  await addShots(id, 'scheduled', 7, 100000);
  await addShots(id, 'manual', 2, 100000);
  const page = await openPage(`${srv.base}/`);
  const wait = (expr, ms = 8000) => page.run(`new Promise((res, rej) => { const t0 = Date.now(); const i = setInterval(() => { let ok = false; try { ok = !!(${expr}); } catch {} if (ok) { clearInterval(i); res(true); } else if (Date.now() - t0 > ${ms}) { clearInterval(i); rej(new Error('délai : ' + ${JSON.stringify(expr)})); } }, 80); })`);
  try {
    await page.run(`fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'boss', password: 'motdepasse-test-1' }) }).then((r) => r.status)`);
    await page.navigate(`${srv.base}/`);
    await wait('document.querySelector(".sidebar")');
    await page.run(`location.hash = '#/sites/${id}/captures'`);
    await wait('document.querySelector(".shots .shot")');
    const line = await page.run('document.querySelector(".card").textContent');
    assert.match(line, /Conservation : 168 captures planifiées par site \(et jusqu'à 100 manuelles ou d'alerte\) · en stock : 9 · 878,9 Ko/);

    // Formulaire : la durée couverte suit la limite et la fréquence.
    await page.run(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Modifier').click()`);
    await wait('document.querySelector(".drawer")');
    await page.run(`[...document.querySelectorAll('.drawer details')].find((d) => d.textContent.includes("Capture d'écran")).open = true`);
    const hint = () => page.run(`(() => { const f = [...document.querySelectorAll('.drawer .field')].find((x) => x.querySelector('label')?.textContent === 'Captures à conserver'); return f.querySelector('.hint').textContent; })()`);
    assert.match(await hint(), /Environ 7 jours d'historique/, '168 captures à 1 h');
    await page.run(`(() => { const f = [...document.querySelectorAll('.drawer .field')].find((x) => x.querySelector('label')?.textContent === 'Captures à conserver'); const s = f.querySelector('select'); s.value = '24'; s.dispatchEvent(new Event('change')); })()`);
    assert.match(await hint(), /Environ 24 heures d'historique/, '24 captures à 1 h');
    await page.run(`(() => { const f = [...document.querySelectorAll('.drawer .field')].find((x) => x.querySelector('label')?.textContent === 'Fréquence'); const s = f.querySelector('select'); s.value = '1440'; s.dispatchEvent(new Event('change')); })()`);
    assert.match(await hint(), /Environ 24 jours d'historique/, '24 captures à 24 h');
    const options = await page.run(`(() => { const f = [...document.querySelectorAll('.drawer .field')].find((x) => x.querySelector('label')?.textContent === 'Captures à conserver'); return [...f.querySelectorAll('option')].map((o) => o.textContent); })()`);
    assert.equal(options[0], 'Réglage général (168)');
  } finally {
    page.close();
  }
});

test('SURICATE_CAPTURES=0 : le moteur de capture est indisponible, même avec un Chrome installé', async () => {
  const { execFileSync } = await import('node:child_process');
  const run = (env) => execFileSync(process.execPath, ['--input-type=module', '-e',
    `process.env.CHROME_PATH = process.execPath; const m = await import(${JSON.stringify(new URL('../src/screenshot.js', import.meta.url).href)}); console.log(String(m.engine.available())); process.exit(0);`],
  { env: { ...process.env, DATA_DIR: process.env.DATA_DIR, ...env }, encoding: 'utf8' }).trim().split('\n').pop();
  assert.equal(run({ SURICATE_CAPTURES: '' }), 'true', 'par défaut : un navigateur est détecté (ici, un chemin existant via CHROME_PATH)');
  assert.equal(run({ SURICATE_CAPTURES: '0' }), 'false');
  assert.equal(run({ SURICATE_CAPTURES: 'false' }), 'false');
});
