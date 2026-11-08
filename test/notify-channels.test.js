// Canaux de notification : le cœur envoie sur Telegram ; une extension peut fournir d'autres canaux (src/notify.js, src/extensions.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'vigie-notify-'));
process.env.CHROME_PATH = '/nonexistent/chrome'; // aucune capture : on teste l'acheminement, pas la photo

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

let page = '<html><head><title>Boutique</title></head><body><p>Artisan depuis 1987.</p><p>Contact</p><p>Mentions légales</p></body></html>';
const site = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page);
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const siteUrl = `http://127.0.0.1:${site.address().port}/`;

const dbm = await import('../src/db.js');
const { runCheck } = await import('../src/checker.js');
const { eligibleFor, defaultNotifier, telegramChannel } = await import('../src/notify.js');
const { configureExtensions, resetExtensions, getExtensions } = await import('../src/extensions.js');

const NO_NET = { checks: { dns: false, tls: false, rdap: false } };
const mk = (name, config = {}) => dbm.createWatch({ name, url: siteUrl, interval: 5, config: { ...NO_NET, ...config } });
/** Un passage de référence, puis une modification : une alerte « contenu modifié » (gravité attention). */
let offers = 0;
async function changeAndCheck(w) {
  await runCheck(w.id); // référence
  page = page.replace('</body>', `<p>Nouvelle offre ${++offers}</p></body>`);
  return runCheck(w.id);
}
const notifiedOf = async (id) => (await dbm.db.all('SELECT id, notified, notify_error FROM alerts WHERE watch_id = ? ORDER BY id', [id])).map((r) => ({ ...r }));

test.beforeEach(() => {
  resetExtensions();
  sent.length = 0;
});

test('eligibleFor : gravité minimale, et rétablissement seulement si l\'incident clos avait été signalé', () => {
  const alerts = [{ severity: 'info' }, { severity: 'warning' }, { severity: 'critical' }, { severity: 'recovery', was: 'warning' }, { severity: 'recovery', was: 'info' }];
  const sev = (list) => list.map((a) => a.severity + (a.was ? `:${a.was}` : ''));
  assert.deepEqual(sev(eligibleFor({ minSeverity: 'warning', sendRecovery: true }, alerts)), ['warning', 'critical', 'recovery:warning']);
  assert.deepEqual(sev(eligibleFor({ minSeverity: 'critical', sendRecovery: true }, alerts)), ['critical']);
  assert.deepEqual(sev(eligibleFor({ minSeverity: 'info', sendRecovery: false }, alerts)), ['info', 'warning', 'critical']);
  assert.equal(eligibleFor({ minSeverity: '', sendRecovery: false }, alerts).length, 3, 'sans gravité : tout, sauf rétablissements coupés');
});

test('canal par défaut : Telegram, seulement s\'il est configuré et activé ; la gravité du site l\'emporte', () => {
  const watch = { config: { minSeverity: '' } };
  const off = { telegram: { token: '', chatId: '', enabled: true } };
  assert.deepEqual(defaultNotifier.resolveChannels(watch, [], off), [], 'sans jeton : aucun canal');
  assert.deepEqual(defaultNotifier.resolveChannels(watch, [], { telegram: { token: 't', chatId: '1', enabled: false } }), [], 'coupé : aucun canal');
  const [ch] = defaultNotifier.resolveChannels(watch, [], { telegram: { token: 't', chatId: '1', enabled: true, minSeverity: 'warning', sendRecovery: true, sendScreenshot: true } });
  assert.equal(ch.type, 'telegram');
  assert.equal(ch.minSeverity, 'warning');
  assert.equal(telegramChannel({ token: 't', chatId: '1', minSeverity: 'warning' }, { config: { minSeverity: 'critical' } }).minSeverity, 'critical');
});

test('par défaut : une alerte part sur Telegram et est marquée envoyée', async () => {
  await dbm.saveSettings({ telegram: { token: '123:ABC', chatId: '42', enabled: true, minSeverity: 'warning', sendRecovery: true } });
  const w = await mk('Par défaut');
  const r = await changeAndCheck(w);
  assert.equal(r.alerts.length, 1);
  assert.equal(sent.length, 1);
  assert.deepEqual((await notifiedOf(w.id)).map((a) => a.notified), [1]);
});

test('canaux fournis par une extension : chacun reçoit les alertes qui lui reviennent, selon sa gravité', async () => {
  const received = { all: [], critical: [] };
  const channel = (name, minSeverity) => ({ type: name, minSeverity, sendRecovery: true, send: async (watch, alerts) => { received[name].push(alerts.map((a) => a.severity)); } });
  const seen = [];
  configureExtensions({ notifier: { resolveChannels: async (watch, alerts) => { seen.push(watch.name); return [channel('all', 'info'), channel('critical', 'critical')]; } } });
  const w = await mk('Deux canaux');
  await changeAndCheck(w);
  assert.deepEqual(seen, ['Deux canaux'], 'le résolveur n\'est interrogé que lorsqu\'il y a des alertes à envoyer (pas au 1er passage)');
  assert.equal(received.all.length, 1, 'le canal « tout » reçoit l\'alerte (attention)');
  assert.equal(received.critical.length, 0, 'le canal « critique » ne reçoit pas une alerte de gravité attention');
  assert.equal(sent.length, 0, 'Telegram n\'est plus utilisé : le résolveur de l\'extension remplace celui du cœur');
});

test('un canal en échec n\'empêche pas les autres ; l\'alerte est « envoyée » si au moins un canal aboutit', async () => {
  const errors = [];
  const origError = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  try {
    const ok = [];
    configureExtensions({ notifier: { resolveChannels: () => [
      { type: 'panne', minSeverity: 'info', sendRecovery: true, send: async () => { throw new Error('serveur de messagerie injoignable'); } },
      { type: 'ok', minSeverity: 'info', sendRecovery: true, send: async (watch, alerts) => { ok.push(alerts.length); } },
    ] } });
    const w = await mk('Un canal en panne');
    await changeAndCheck(w);
    assert.deepEqual(ok, [1], 'le second canal a bien reçu l\'alerte');
    assert.deepEqual((await notifiedOf(w.id)).map((a) => [a.notified, a.notify_error]), [[1, null]]);
    assert.ok(errors.some((e) => /\[panne\].*injoignable/.test(e)), 'l\'échec est journalisé avec le type du canal');
  } finally {
    console.error = origError;
  }
});

test('tous les canaux en échec : l\'alerte garde l\'erreur du dernier échec constaté ; aucun canal : rien n\'est marqué', async () => {
  const origError = console.error;
  console.error = () => {};
  try {
    configureExtensions({ notifier: { resolveChannels: () => [{ type: 'x', minSeverity: 'info', sendRecovery: true, send: async () => { throw new Error('refusé'); } }] } });
    const w = await mk('Tout en échec');
    await changeAndCheck(w);
    assert.deepEqual((await notifiedOf(w.id)).map((a) => [a.notified, a.notify_error]), [[0, 'refusé']]);

    configureExtensions({ notifier: { resolveChannels: () => [] } });
    const w2 = await mk('Aucun canal');
    await changeAndCheck(w2);
    assert.deepEqual((await notifiedOf(w2.id)).map((a) => [a.notified, a.notify_error]), [[0, null]]);
  } finally {
    console.error = origError;
  }
});

test('le réglage « ne pas notifier » du site coupe tous les canaux, sans interroger le résolveur', async () => {
  let asked = 0;
  configureExtensions({ notifier: { resolveChannels: () => { asked++; return []; } } });
  const w = await mk('Muet', { notify: false });
  await changeAndCheck(w);
  assert.equal(asked, 0);
});

test('configureExtensions : un résolveur invalide est refusé ; resetExtensions rétablit le cœur', () => {
  assert.throws(() => configureExtensions({ notifier: {} }), /resolveChannels/);
  configureExtensions({ scheduler: { concurrency: 9 } });
  assert.equal(getExtensions().scheduler.concurrency, 9);
  assert.equal(typeof getExtensions().scheduler.pickDue, 'function', 'les autres valeurs du planificateur sont conservées');
  resetExtensions();
  assert.equal(getExtensions().scheduler.concurrency, 5);
  assert.equal(getExtensions().notifier, defaultNotifier);
});

test.after(() => { fakeTelegram.close(); site.close(); dbm.db.close(); });
