import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'suricate-maint-'));
const sent = [];
const fakeTelegram = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    if (req.url.endsWith('/sendMessage')) sent.push(JSON.parse(b));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, result: {} }));
  });
});
await new Promise((r) => fakeTelegram.listen(0, '127.0.0.1', r));
process.env.TELEGRAM_API = `http://127.0.0.1:${fakeTelegram.address().port}`;

const dbm = await import('../src/db.js');
const { runCheck } = await import('../src/checker.js');

const page = { drop: false, extra: '' };
const site = http.createServer((req, res) => {
  if (page.drop) return req.socket.destroy();
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<html><head><title>Boutique</title></head><body><h1>Boutique Dupont</h1><p>Artisan depuis 1987</p><p>Nos produits</p><p>Notre histoire</p><p>Contact</p><p>Mentions légales</p>${page.extra}</body></html>`);
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const siteUrl = `http://127.0.0.1:${site.address().port}/`;
await dbm.saveSettings({ telegram: { token: '123:ABC', chatId: '42', enabled: true, minSeverity: 'warning', sendRecovery: true, includeDiff: true } });

const types = (r) => r.alerts.map((a) => a.type);
const mk = async (name) => await dbm.createWatch({ name, url: siteUrl, interval: 5, config: { checks: { dns: false, tls: false, rdap: false }, failThreshold: 2, screenshot: { enabled: false } } });
const MIN = 60e3;

test('fenêtres : durée, début différé, fenêtre en cours, fin anticipée, annulation d’une fenêtre à venir', async () => {
  const w = await mk('Fenêtres');
  const now = Date.now();
  assert.equal(await dbm.activeMaintenance(w.id, now), null);
  const a = await dbm.addMaintenance({ watchId: w.id, start: now - MIN, end: now + 30 * MIN, note: 'Mise à jour' });
  const later = await dbm.addMaintenance({ watchId: w.id, start: now + 2 * 3600e3, end: now + 3 * 3600e3 });
  assert.equal((await dbm.activeMaintenance(w.id, now)).id, a.id, 'la fenêtre qui a commencé est active');
  assert.equal(await dbm.activeMaintenance(w.id, now + 31 * MIN), null, 'terminée');
  assert.deepEqual((await dbm.listMaintenance(w.id, now)).map((m) => m.id), [a.id, later.id], 'en cours puis à venir');
  assert.equal((await dbm.activeMaintenanceMap(now)).get(w.id).id, a.id);

  assert.equal((await dbm.endMaintenance(later.id, now)).id, later.id);
  assert.deepEqual((await dbm.listMaintenance(w.id, now)).map((m) => m.id), [a.id], 'fenêtre à venir supprimée');
  await dbm.endMaintenance(a.id, now);
  assert.equal(await dbm.activeMaintenance(w.id, now + 1), null, 'fenêtre en cours arrêtée maintenant');
  assert.equal(await dbm.endMaintenance(a.id, now + 5), null, 'déjà terminée');
  assert.equal(await dbm.endMaintenance(99999), null);
});

test('maintenance : un site coupé n’est pas en panne, rien n’est envoyé, rien n’est compté', async () => {
  const w = await mk('Panne en maintenance');
  await runCheck(w.id); // référence
  const sentBefore = sent.length;
  // Fenêtre plus courte que l'intervalle (5 min) : le contrôle suivant est avancé pour tomber juste après sa fin.
  const win = await dbm.addMaintenance({ watchId: w.id, start: Date.now() - MIN, end: Date.now() + 2 * MIN });

  page.drop = true;
  for (let i = 0; i < 4; i++) assert.deepEqual(types(await runCheck(w.id)), [], 'aucune alerte « site inaccessible »');
  const st = (await dbm.getWatch(w.id)).state;
  assert.equal(st.outageId ?? null, null, 'aucune panne ouverte');
  assert.equal(st.fails, 0, 'les échecs de la maintenance ne s’accumulent pas');
  assert.deepEqual(await dbm.outageList(w.id), [], 'aucune ligne dans l’historique des pannes');
  assert.equal(sent.length, sentBefore, 'rien sur Telegram');
  assert.equal((await dbm.getWatch(w.id)).nextRun, win.end + 30e3, 'un contrôle est prévu juste après la fin de la fenêtre');

  // La fenêtre se termine alors que le site est encore coupé : la panne est datée d'APRÈS la fenêtre.
  await dbm.endMaintenance(win.id);
  const t0 = Date.now();
  assert.deepEqual(types(await runCheck(w.id)), [], '1er échec après la reprise : pas encore confirmé');
  const r = await runCheck(w.id);
  assert.deepEqual(types(r), ['down'], '2e échec : la panne est annoncée');
  assert.ok((await dbm.outageList(w.id))[0].start >= t0 - 50, 'la maintenance ne compte pas rétroactivement dans la panne');
  page.drop = false;
  await runCheck(w.id);
});

test('maintenance : un texte de piratage apparu pendant la fenêtre est annoncé à la reprise', async () => {
  const w = await mk('Piratage en maintenance');
  await runCheck(w.id);
  const win = await dbm.addMaintenance({ watchId: w.id, start: Date.now() - MIN, end: Date.now() + 10 * MIN });
  const sentBefore = sent.length;

  page.extra = '<p>Hacked by Evil Crew</p>';
  const r = await runCheck(w.id);
  assert.ok(types(r).includes('forbidden'), 'l’alerte est bien enregistrée au journal');
  assert.ok(r.alerts.every((a) => a.maintenance), 'mais marquée « maintenance »');
  assert.equal(sent.length, sentBefore, 'et non envoyée');
  const rows = await dbm.db.all("SELECT read, notified, maintenance FROM alerts WHERE watch_id = ? AND type = 'forbidden'", [w.id]);
  assert.deepEqual(rows.map((x) => ({ ...x })), [{ read: 1, notified: 0, maintenance: 1 }], 'déjà lue, non notifiée, retenue');
  assert.deepEqual(types(await runCheck(w.id)), [], 'pas de doublon pendant la fenêtre');

  await dbm.endMaintenance(win.id);
  const after = await runCheck(w.id);
  assert.deepEqual(types(after).sort(), ['forbidden', 'maintenance_summary'], 'à la reprise : l’incident toujours présent + un récapitulatif');
  assert.ok(after.alerts.every((a) => !a.maintenance));
  assert.equal(after.alerts.find((a) => a.type === 'maintenance_summary').severity, 'critical');
  assert.equal(sent.length, sentBefore + 1, 'un seul message Telegram groupé');
  assert.match(sent.at(-1).text, /Fin de la maintenance : 2 alertes retenues/);
  assert.match(sent.at(-1).text, /Hacked by|hacked by/i);
  assert.deepEqual((await dbm.db.all('SELECT maintenance FROM alerts WHERE watch_id = ? AND type = ? ORDER BY id', [w.id, 'forbidden'])).map((r) => r.maintenance), [2, 0],
    'l’alerte retenue est reprise dans le récapitulatif ; celle de la reprise est une alerte normale');

  assert.deepEqual(types(await runCheck(w.id)), [], 'ensuite : silence, pas de répétition');
  page.extra = '';
  const fixed = await runCheck(w.id);
  assert.ok(types(fixed).includes('recovery'), 'le retour à la normale est annoncé comme d’habitude');
});

test('maintenance : un incident apparu puis disparu pendant la fenêtre ne produit aucun « rétabli » trompeur', async () => {
  const w = await mk('Incident éphémère');
  await runCheck(w.id);
  const win = await dbm.addMaintenance({ watchId: w.id, start: Date.now() - MIN, end: Date.now() + 10 * MIN });
  const sentBefore = sent.length;
  page.extra = '<p>Hacked by Evil Crew</p>';
  await runCheck(w.id);
  page.extra = '';
  const r = await runCheck(w.id);
  assert.equal(types(r).includes('recovery'), false, 'personne n’a été prévenu de l’incident : pas de « rétabli »');
  assert.equal(sent.length, sentBefore);

  await dbm.endMaintenance(win.id);
  const after = await runCheck(w.id);
  assert.deepEqual(types(after), ['maintenance_summary'], 'le récapitulatif garde la trace de ce qui s’est passé');
  assert.match(sent.at(-1).text, /Fin de la maintenance/);
});

test('maintenance : sans alerte pendant la fenêtre, aucun récapitulatif', async () => {
  const w = await mk('Maintenance calme');
  await runCheck(w.id);
  const win = await dbm.addMaintenance({ watchId: w.id, start: Date.now() - MIN, end: Date.now() + 10 * MIN });
  const sentBefore = sent.length;
  assert.deepEqual(types(await runCheck(w.id)), []);
  await dbm.endMaintenance(win.id);
  assert.deepEqual(types(await runCheck(w.id)), []);
  assert.equal(sent.length, sentBefore);
});

test('maintenance : une fenêtre ne concerne que son site', async () => {
  const a = await mk('Site A');
  const b = await mk('Site B');
  await runCheck(a.id);
  await runCheck(b.id);
  await dbm.addMaintenance({ watchId: a.id, start: Date.now() - MIN, end: Date.now() + 10 * MIN });
  page.extra = '<p>Hacked by Evil Crew</p>';
  const ra = await runCheck(a.id);
  const rb = await runCheck(b.id);
  assert.ok(ra.alerts.every((x) => x.maintenance), 'A est en maintenance');
  assert.ok(rb.alerts.length && rb.alerts.every((x) => !x.maintenance), 'B est surveillé normalement');
  page.extra = '';
});

test.afterEach(() => { page.drop = false; page.extra = ''; });

test.after(() => {
  site.close();
  fakeTelegram.close();
  dbm.db.close();
});
