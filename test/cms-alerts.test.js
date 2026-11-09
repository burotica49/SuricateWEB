import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'suricate-cmsal-'));
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

const { phpSupport, carrySince, cmsIncidents } = await import('../src/cms-alerts.js');
const dbm = await import('../src/db.js');
const { runCheck } = await import('../src/checker.js');

const D = 86400e3;
const NOW = Date.parse('2026-11-02T10:00:00Z');

test('PHP : support de sécurité terminé, bientôt terminé, en cours, inconnu', () => {
  assert.equal(phpSupport('8.1.30', NOW).status, 'ended');
  assert.equal(phpSupport('7.4.33', NOW).status, 'ended');
  assert.equal(phpSupport('5.3.29', NOW).status, 'ended', 'branche plus ancienne que le tableau');
  assert.equal(phpSupport('5.3.29', NOW).endsAt, null);
  const ending = phpSupport('8.2.27', NOW);
  assert.equal(ending.status, 'ending');
  assert.equal(ending.days, 59, 'jusqu’au 31 décembre 2026 inclus');
  assert.equal(phpSupport('8.3.14', NOW).status, 'ok');
  assert.equal(phpSupport('8.5.0', NOW).status, 'ok');
  assert.equal(phpSupport('9.0.1', NOW).status, 'unknown', 'une branche trop récente n’est jamais signalée');
  assert.equal(phpSupport('8.2.27-1ubuntu1', NOW).branch, '8.2', 'suffixe de distribution ignoré');
  assert.equal(phpSupport('', NOW), null);
  assert.equal(phpSupport(null, NOW), null);
  assert.equal(phpSupport('n/a', NOW), null);
  // exactement 90 jours avant la fin : on prévient ; 91 jours : pas encore
  const end = Date.parse('2026-12-31T23:59:59Z');
  assert.equal(phpSupport('8.2.1', end - 90 * D).status, 'ending');
  assert.equal(phpSupport('8.2.1', end - 92 * D).status, 'ok');
  assert.equal(phpSupport('8.2.1', end + D).status, 'ended');
});

test('ancienneté d’une mise à jour : conservée tant que la version proposée est la même', () => {
  const rep = (core, ext) => ({ core: { current: '6.7', available: core }, extensions: [{ name: 'Yoast', slug: 'wordpress-seo', current: '1', available: ext }], themes: [] });
  const first = carrySince(null, rep('6.8', '2.0'), NOW);
  assert.equal(first.core.since, NOW);
  assert.equal(first.extensions[0].since, NOW);

  const again = carrySince(first, rep('6.8', '2.0'), NOW + 5 * D);
  assert.equal(again.core.since, NOW, 'même version proposée : l’ancienneté continue');
  assert.equal(again.extensions[0].since, NOW);

  const newer = carrySince(again, rep('6.8.1', '2.0'), NOW + 6 * D);
  assert.equal(newer.core.since, NOW + 6 * D, 'une version encore plus récente repart de zéro');
  assert.equal(newer.extensions[0].since, NOW, 'l’extension n’a pas bougé');

  const done = carrySince(newer, rep(null, null), NOW + 7 * D);
  assert.equal('since' in done.core, false, 'mise à jour faite : plus d’ancienneté');
  assert.equal('since' in done.extensions[0], false);
  const back = carrySince(done, rep('6.9', null), NOW + 8 * D);
  assert.equal(back.core.since, NOW + 8 * D, 'une nouvelle mise à jour compte depuis sa propre apparition');
});

test('incidents : seuil d’ancienneté, gravité du noyau, regroupement des extensions', () => {
  const rep = {
    cms: 'wordpress', php: '8.3.14',
    core: { current: '6.7.1', available: '6.8.3', since: NOW - 12 * D },
    extensions: [
      { name: 'Yoast SEO', slug: 'wordpress-seo', current: '24.2', available: '25.4', active: true, since: NOW - 9 * D },
      { name: 'Contact Form 7', slug: 'cf7', current: '5.9', available: '6.1', active: true, since: NOW - 3 * D },
      { name: 'Hello Dolly', slug: 'hello-dolly', current: '1.0', available: '1.1', active: false, since: NOW - 20 * D },
      { name: 'À jour', slug: 'ok', current: '1', available: null, active: true },
    ],
    themes: [{ name: 'Twenty Twenty-Five', slug: 'tt5', current: '1.0', available: '1.3', active: false, since: NOW - 8 * D }],
  };
  const inc = Object.fromEntries(cmsIncidents(rep, { afterDays: 7, now: NOW }).map((i) => [i.key, i]));
  assert.deepEqual(Object.keys(inc).sort(), ['cms_core', 'cms_updates']);
  assert.equal(inc.cms_core.severity, 'warning');
  assert.match(inc.cms_core.title, /WordPress 6\.8\.3 est disponible depuis 12 jours/);
  assert.match(inc.cms_updates.title, /^3 mises à jour en attente depuis plus de 7 jours$/);
  assert.match(inc.cms_updates.detail, /Yoast SEO \(extension\) : 24\.2 → 25\.4 · en attente depuis 9 j/);
  assert.match(inc.cms_updates.detail, /Hello Dolly \(extension, inactif\)/);
  assert.match(inc.cms_updates.detail, /Twenty Twenty-Five \(thème, inactif\)/);
  assert.doesNotMatch(inc.cms_updates.detail, /Contact Form 7/, '3 jours : pas encore signalée');
  assert.ok(inc.cms_updates.detail.indexOf('Hello Dolly') < inc.cms_updates.detail.indexOf('Yoast'), 'les plus anciennes d’abord');

  assert.deepEqual(cmsIncidents(rep, { afterDays: 30, now: NOW }).map((i) => i.key), [], 'seuil de 30 jours : rien d’assez ancien');
  rep.core.since = NOW - 31 * D;
  assert.equal(cmsIncidents(rep, { afterDays: 7, now: NOW }).find((i) => i.key === 'cms_core').severity, 'critical', '30 jours de retard = critique');
  assert.equal(cmsIncidents(null, { now: NOW }).length, 0);
  assert.equal(cmsIncidents({ cms: 'wordpress', core: {}, extensions: [], themes: [] }, { now: NOW }).length, 0);

  const ps = cmsIncidents({ cms: 'prestashop', core: { current: '8.1.7', available: '8.2.1', since: NOW - 8 * D }, extensions: [{ name: 'Panier', slug: 'ps_shoppingcart', current: '2.0.7', available: '2.0.9', since: NOW - 8 * D }], themes: [] }, { now: NOW });
  assert.match(ps.find((i) => i.key === 'cms_core').title, /^PrestaShop 8\.2\.1/);
  assert.match(ps.find((i) => i.key === 'cms_updates').detail, /Panier \(module\)/);

  const many = { cms: 'wordpress', core: {}, themes: [], extensions: Array.from({ length: 11 }, (_, k) => ({ name: `Ext ${k}`, slug: `e${k}`, current: '1', available: '2', since: NOW - 10 * D })) };
  const m = cmsIncidents(many, { now: NOW }).find((i) => i.key === 'cms_updates');
  assert.match(m.title, /^11 mises à jour/);
  assert.match(m.detail, /… et 3 autre\(s\)$/);
});

test('incidents : PHP en fin de support (critique) ou bientôt (avertissement)', () => {
  const base = { cms: 'wordpress', core: {}, extensions: [], themes: [] };
  const ended = cmsIncidents({ ...base, php: '8.0.30' }, { now: NOW });
  assert.equal(ended.length, 1);
  assert.deepEqual([ended[0].key, ended[0].severity], ['php_eol', 'critical']);
  assert.match(ended[0].title, /PHP 8\.0 n'est plus maintenu/);
  assert.match(ended[0].detail, /depuis le 26\/11\/2023/);
  const soon = cmsIncidents({ ...base, php: '8.2.27' }, { now: NOW });
  assert.deepEqual([soon[0].key, soon[0].severity], ['php_eol', 'warning']);
  assert.match(soon[0].title, /PHP 8\.2 ne sera plus maintenu le 31\/12\/2026/);
  assert.match(soon[0].detail, /dans 59 jours/);
  assert.equal(cmsIncidents({ ...base, php: '8.4.1' }, { now: NOW }).length, 0);
  assert.equal(cmsIncidents({ ...base, php: null }, { now: NOW }).length, 0);
});

// ── Moteur : un faux site, un faux Telegram, et un relevé CMS enregistré à la main ──
const site = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<html><head><title>Cabinet</title></head><body><h1>Cabinet Martin</h1><p>Bienvenue</p><p>Nos missions</p><p>Contact</p><p>Mentions</p><p>Actualités</p></body></html>');
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const siteUrl = `http://127.0.0.1:${site.address().port}/`;
await dbm.saveSettings({ telegram: { token: '123:ABC', chatId: '42', enabled: true, minSeverity: 'warning', sendRecovery: true, includeDiff: true } });
const watch = await dbm.createWatch({ name: 'Cabinet', url: siteUrl, interval: 5, config: { checks: { dns: false, tls: false, rdap: false }, cms: { type: 'wordpress', token: 'a'.repeat(32), intervalMin: 720 } } });
const types = (r) => r.alerts.map((a) => a.type);
const report = (over = {}) => ({
  php: '8.3.14', cms: 'wordpress', cmsVersion: '6.7.1', ok: true, error: null, checkedAt: Date.now(),
  core: { current: '6.7.1', available: '6.8.3', known: true, since: Date.now() - 12 * D },
  extensions: [{ name: 'Yoast SEO', slug: 'wordpress-seo', current: '24.2', available: '25.4', active: true, known: true, since: Date.now() - 9 * D }],
  themes: [], ...over,
});

test('moteur : le 1er passage pose la référence, puis les mises à jour en retard alertent une seule fois', async () => {
  await dbm.setCmsReport(watch.id, report(), Date.now() + 1e6);
  // Comme un certificat qui expire : un état anormal s'annonce dès qu'il est vu, même au 1er passage.
  const r = await runCheck(watch.id);
  assert.deepEqual(types(r), ['cms_core', 'cms_updates']);
  assert.deepEqual(r.alerts.map((a) => a.severity), ['warning', 'warning']);
  assert.equal(sent.length, 1, 'un seul message Telegram pour les deux alertes');
  assert.match(sent[0].text, /WordPress 6\.8\.3 est disponible depuis 12 jours/);
  assert.match(sent[0].text, /Yoast SEO/);
  assert.deepEqual(Object.keys((await dbm.getWatch(watch.id)).state.incidents).sort(), ['cms_core', 'cms_updates']);
});

test('moteur : pas de répétition, puis « rétabli » quand tout est à jour', async () => {
  const before = sent.length;
  assert.deepEqual(types(await runCheck(watch.id)), [], 'deuxième passage : silence, l’incident est déjà connu');
  assert.equal(sent.length, before);
  await dbm.setCmsReport(watch.id, report({ core: { current: '6.8.3', available: null, known: true }, extensions: [{ name: 'Yoast SEO', slug: 'wordpress-seo', current: '25.4', available: null, active: true, known: true }] }), Date.now() + 1e6);
  const r = await runCheck(watch.id);
  assert.deepEqual(types(r), ['recovery', 'recovery']);
  assert.match(sent.at(-1).text, /Rétabli|RÉTABLI/);
  assert.deepEqual(Object.keys((await dbm.getWatch(watch.id)).state.incidents), []);
});

test.after(() => {
  site.close();
  fakeTelegram.close();
  dbm.db.close();
});

test('moteur : PHP en fin de support, puis alertes coupées pour ce site sans message « rétabli »', async () => {
  await dbm.setCmsReport(watch.id, report({ php: '7.4.33', core: { current: '6.8.3', available: null, known: true }, extensions: [] }), Date.now() + 1e6);
  const r = await runCheck(watch.id);
  assert.deepEqual(types(r), ['php_eol']);
  assert.equal(r.alerts[0].severity, 'critical');
  assert.match(sent.at(-1).text, /PHP 7\.4 n'est plus maintenu/);
  assert.deepEqual(types(await runCheck(watch.id)), [], 'pas de répétition');

  const count = sent.length;
  const cur = await dbm.getWatch(watch.id);
  await dbm.updateWatch(watch.id, { config: { ...cur.config, cms: { ...cur.config.cms, alerts: false } } });
  assert.deepEqual(types(await runCheck(watch.id)), [], 'alertes coupées : l’incident disparaît en silence');
  assert.equal(sent.length, count, 'aucun message, surtout pas un « rétabli » trompeur');
  assert.deepEqual(Object.keys((await dbm.getWatch(watch.id)).state.incidents), []);
});

test('moteur : une version de PHP trop récente pour le tableau ne déclenche rien', async () => {
  const cur = await dbm.getWatch(watch.id);
  await dbm.updateWatch(watch.id, { config: { ...cur.config, cms: { ...cur.config.cms, alerts: true } } });
  await dbm.setCmsReport(watch.id, report({ php: '9.9.1', core: { current: '6.8.3', available: null, known: true }, extensions: [] }), Date.now() + 1e6);
  assert.deepEqual(types(await runCheck(watch.id)), []);
});

test('moteur : sans CMS configuré, un relevé enregistré n’alerte pas', async () => {
  const w2 = await dbm.createWatch({ name: 'Sans CMS', url: siteUrl, interval: 5, config: { checks: { dns: false, tls: false, rdap: false } } });
  await dbm.setCmsReport(w2.id, report({ php: '5.6.40' }), 0);
  assert.deepEqual(types(await runCheck(w2.id)), []);
});
