import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Sécurité du CMS : intégrité des fichiers et comptes administrateurs (plugin 1.1).
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'vigie-cmssec-'));
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

const { carryAdmins, acceptAdmins, carryHistory, cmsIncidents, cmsIncidentGroup } = await import('../src/cms-alerts.js');
const dbm = await import('../src/db.js');
const { parseCmsReport, parseIntegrityReport, pollCms, acceptCmsAdmins } = await import('../src/cms.js');
const { runCheck } = await import('../src/checker.js');

const TOKEN = 'jeton-de-test-assez-long';
const D = 86400e3;
const NOW = Date.parse('2026-11-02T10:00:00Z');

test('administrateurs : le 1er relevé fixe la référence sans alerter', () => {
  const r = carryAdmins(null, { admins: { count: 2, recent: [{ id: 7, login: 'recent', registered: NOW - 5 * D }] } }, NOW);
  assert.deepEqual(r.admins.known, [7]);
  assert.equal(r.admins.baseCount, 2);
  assert.deepEqual(r.admins.added, []);
  assert.equal(r.admins.extra, 0);
  assert.equal(cmsIncidents({ cms: 'wordpress', core: {}, extensions: [], themes: [], admins: r.admins }, { now: NOW }).length, 0);
  assert.equal('admins' in carryAdmins(null, { admins: null }, NOW), false, 'plugin sans cette donnée : rien n’est inventé');
});

test('administrateurs : nouveau compte, compte promu, compte vieilli, acceptation', () => {
  const base = carryAdmins(null, { admins: { count: 2, recent: [] } }, NOW).admins;
  const mk = (admins) => ({ cms: 'wordpress', core: {}, extensions: [], themes: [], admins });

  // Un compte créé hier
  const day1 = carryAdmins({ admins: base }, { admins: { count: 3, recent: [{ id: 9, login: 'pirate', registered: NOW - D }] } }, NOW + D).admins;
  assert.deepEqual(day1.added.map((a) => a.login), ['pirate']);
  assert.equal(day1.added[0].since, NOW + D);
  const [inc] = cmsIncidents(mk(day1), { now: NOW });
  assert.deepEqual([inc.key, inc.severity, inc.count], ['cms_admins', 'critical', 1]);
  assert.match(inc.title, /^Nouvel administrateur : pirate$/);
  assert.match(inc.detail, /pirate \(créé le 01\/11\/2026\)/);
  assert.match(inc.detail, /Je connais ces comptes/);

  // L'ancienneté de la détection ne bouge pas d'un relevé à l'autre
  const day2 = carryAdmins({ admins: day1 }, { admins: { count: 3, recent: [{ id: 9, login: 'pirate', registered: NOW - D }] } }, NOW + 2 * D).admins;
  assert.equal(day2.added[0].since, NOW + D);

  // 31 jours plus tard le compte sort de la liste « récente » mais reste un compte en trop : toujours signalé
  const old = carryAdmins({ admins: day2 }, { admins: { count: 3, recent: [] } }, NOW + 40 * D).admins;
  assert.deepEqual(old.added.map((a) => a.id), [9], 'conservé tant que le compteur le montre');
  assert.equal(old.extra, 0);

  // Le compte est supprimé : plus rien
  const gone = carryAdmins({ admins: old }, { admins: { count: 2, recent: [] } }, NOW + 41 * D).admins;
  assert.deepEqual(gone.added, []);
  assert.equal(cmsIncidents(mk(gone), { now: NOW }).length, 0);

  // Un compte existant promu : le compteur monte sans création récente
  const promoted = carryAdmins({ admins: base }, { admins: { count: 3, recent: [] } }, NOW + D).admins;
  assert.equal(promoted.extra, 1);
  const [pi] = cmsIncidents(mk(promoted), { now: NOW });
  assert.match(pi.title, /^1 nouveau compte administrateur \(2 → 3\)$/);
  assert.match(pi.detail, /promu/);

  // Un administrateur légitime supprimé : la référence baisse, une promotion ultérieure est vue
  const less = carryAdmins({ admins: base }, { admins: { count: 1, recent: [] } }, NOW + D).admins;
  assert.equal(less.baseCount, 1);
  assert.equal(carryAdmins({ admins: less }, { admins: { count: 2, recent: [] } }, NOW + 2 * D).admins.extra, 1);

  // Je connais ces comptes
  const accepted = acceptAdmins(day1);
  assert.deepEqual(accepted.added, []);
  assert.equal(accepted.baseCount, 3);
  assert.ok(accepted.known.includes(9));
  assert.equal(cmsIncidents(mk(accepted), { now: NOW }).length, 0);
  const next = carryAdmins({ admins: accepted }, { admins: { count: 3, recent: [{ id: 9, login: 'pirate', registered: NOW - D }] } }, NOW + 3 * D).admins;
  assert.deepEqual(next.added, [], 'le compte accepté ne revient pas');
});

test('intégrité : incidents du noyau, des extensions et des téléversements', () => {
  const ok = { known: true, checked: 3000, modified: [], added: [], missing: [], more: 0 };
  const rep = (integrity) => ({ cms: 'wordpress', core: {}, extensions: [], themes: [], integrity });
  assert.equal(cmsIncidents(rep({ core: ok, plugins: [{ name: 'Akismet', slug: 'akismet', ...ok }], uploads: { php: [], more: 0 } }), { now: NOW }).length, 0, 'site conforme');
  assert.equal(cmsIncidents(rep({ core: { ...ok, known: false, modified: ['x.php'] }, plugins: [], uploads: { php: [] } }), { now: NOW }).length, 0, 'sommes inconnues : on ne conclut rien');
  assert.equal(cmsIncidents({ cms: 'wordpress', core: {}, extensions: [], themes: [], integrity: { ok: false, error: 'Plugin trop ancien' } }, { now: NOW }).length, 0, 'erreur de contrôle : pas d’alerte inventée');

  const inc = Object.fromEntries(cmsIncidents(rep({
    core: { ...ok, modified: ['wp-admin/index.php'], added: ['wp-includes/class-x.php'] },
    plugins: [{ name: 'Akismet', slug: 'akismet', ...ok, modified: ['class.php'] }, { name: 'Premium', slug: 'premium', known: false, checked: 0, modified: [], added: [], missing: [], more: 0 }],
    uploads: { php: ['2026/evil.php'], more: 2 },
  }), { now: NOW }).map((i) => [i.key, i]));
  assert.deepEqual(Object.keys(inc).sort(), ['cms_integrity_core', 'cms_integrity_plugins', 'cms_integrity_uploads']);
  assert.equal(inc.cms_integrity_core.severity, 'critical');
  assert.match(inc.cms_integrity_core.title, /^Noyau WordPress : 1 fichier modifié, 1 fichier PHP ajouté$/);
  assert.match(inc.cms_integrity_core.detail, /wp-admin\/index\.php \(modifié\)/);
  assert.match(inc.cms_integrity_core.detail, /porte dérobée/);
  assert.equal(inc.cms_integrity_core.count, 2);
  assert.match(inc.cms_integrity_plugins.title, /^1 extension du dépôt officiel avec des fichiers inattendus : Akismet$/);
  assert.match(inc.cms_integrity_plugins.detail, /Akismet : class\.php \(modifié\)/);
  assert.doesNotMatch(inc.cms_integrity_plugins.detail, /Premium/, 'une extension hors dépôt n’est pas comparée');
  assert.match(inc.cms_integrity_uploads.title, /^3 fichiers PHP trouvés dans uploads$/);
  assert.equal(inc.cms_integrity_uploads.count, 3);

  // Fichiers manquants seuls : avertissement
  const missing = cmsIncidents(rep({ core: { ...ok, missing: ['wp-includes/a.php'] }, plugins: [], uploads: { php: [] } }), { now: NOW });
  assert.deepEqual([missing[0].key, missing[0].severity], ['cms_integrity_core', 'warning']);

  // PrestaShop : textes adaptés
  const shop = cmsIncidents({ cms: 'prestashop', core: {}, extensions: [], themes: [], integrity: { core: { ...ok, known: false }, plugins: [], uploads: { php: ['img/cms/x.php'], more: 0 } } }, { now: NOW });
  assert.match(shop[0].title, /dans les dossiers de médias/);
  assert.match(shop[0].detail, /img\/, upload\/, download\//);

  // Groupes réglables séparément
  const all = { cms: 'wordpress', php: '7.4.1', core: {}, extensions: [], themes: [], integrity: { core: { ...ok, modified: ['a.php'] }, plugins: [], uploads: { php: [] } } };
  assert.deepEqual(cmsIncidents(all, { now: NOW, security: false }).map((i) => i.key), ['php_eol']);
  assert.deepEqual(cmsIncidents(all, { now: NOW, updates: false }).map((i) => i.key), ['cms_integrity_core']);
  assert.equal(cmsIncidentGroup('cms_admins'), 'security');
  assert.equal(cmsIncidentGroup('cms_integrity_uploads'), 'security');
  assert.equal(cmsIncidentGroup('php_eol'), 'updates');
  assert.equal(cmsIncidentGroup('cms_core'), 'updates');
});

test('historique des mises à jour : version installée qui change d’un relevé à l’autre', () => {
  const rep = (core, ext) => ({ cms: 'wordpress', core: { current: core }, extensions: ext, themes: [] });
  const first = carryHistory(null, rep('6.7.1', [{ name: 'Yoast', slug: 'wp-seo', current: '24.2' }]), NOW);
  assert.deepEqual(first.history, [], 'premier relevé : rien à comparer');
  const second = carryHistory(first, rep('6.8', [{ name: 'Yoast', slug: 'wp-seo', current: '25.0' }, { name: 'Neuf', slug: 'neuf', current: '1.0' }]), NOW + D);
  assert.deepEqual(second.history.map((h) => [h.kind, h.name, h.from, h.to]), [['core', 'WordPress', '6.7.1', '6.8'], ['ext', 'Yoast', '24.2', '25.0'], ['ext', 'Neuf', null, '1.0']]);
  const third = carryHistory(second, rep('6.8', [{ name: 'Yoast', slug: 'wp-seo', current: '25.0' }, { name: 'Neuf', slug: 'neuf', current: '1.0' }]), NOW + 2 * D);
  assert.equal(third.history.length, 3, 'rien de nouveau, rien ajouté');
  const later = carryHistory(third, rep('6.8', []), NOW + 500 * D);
  assert.equal(later.history.length, 0, 'plus de 400 jours : oubliées');
});

test('réponses du plugin : administrateurs et intégrité bornés, plugin ancien reconnu', () => {
  const r = parseCmsReport(JSON.stringify({
    cms: 'wordpress', php: '8.3.1', core: { current: '6.8' }, extensions: [], themes: [],
    admins: { count: 3, windowDays: 30, recent: [{ id: 9, login: 'a\u0000b<i>', registered: '2026-10-30T10:00:00Z' }, { id: 'x' }, { id: 10, login: 'ok', registered: 'n/importe/quoi' }] },
  }), 'wordpress');
  assert.equal(r.admins.count, 3);
  assert.equal(r.admins.recent.length, 2);
  assert.equal(r.admins.recent[0].login, 'ab<i>');
  assert.equal(r.admins.recent[0].registered, Date.parse('2026-10-30T10:00:00Z'));
  assert.equal(r.admins.recent[1].registered, null);
  assert.equal(parseCmsReport(JSON.stringify({ cms: 'wordpress', core: {} }), 'wordpress').admins, null);
  assert.equal(parseCmsReport(JSON.stringify({ cms: 'wordpress', core: {}, admins: { count: -1 } }), 'wordpress').admins, null);

  const i = parseIntegrityReport(JSON.stringify({
    cms: 'wordpress',
    integrity: {
      core: { known: true, version: '6.8', checked: 3000, modified: ['a.php', 'b\u0007.php'], added: [], missing: [], more: 3 },
      plugins: [{ name: 'Akismet', slug: 'akismet', version: '5.3', known: true, checked: 3, modified: [], added: ['x.php'], missing: [], more: 0 }, { name: 'Hors', slug: 'hors', version: '1', known: false, skipped: true }],
      uploads: { php: ['2026/e.php'], more: 0, scanned: 12, truncated: false },
      partial: true,
    },
  }), 'wordpress');
  assert.deepEqual(i.core.modified, ['a.php', 'b.php']);
  assert.equal(i.core.more, 3);
  assert.equal(i.plugins[1].skipped, true);
  assert.equal(i.plugins[0].added[0], 'x.php');
  assert.deepEqual(i.uploads, { php: ['2026/e.php'], more: 0, scanned: 12, truncated: false });
  assert.equal(i.partial, true);
  assert.throws(() => parseIntegrityReport(JSON.stringify({ cms: 'wordpress', php: '8.3' }), 'wordpress'), /trop ancien/);
  assert.throws(() => parseIntegrityReport(JSON.stringify({ cms: 'prestashop', integrity: {} }), 'wordpress'), /invalide/);
  const long = parseIntegrityReport(JSON.stringify({ cms: 'wordpress', integrity: { core: { known: true, modified: Array.from({ length: 200 }, (_, k) => `f${k}.php`) } } }), 'wordpress');
  assert.equal(long.core.modified.length, 50, 'listes bornées');
});

// ── Relevé complet contre un faux plugin ──
let integrityMode = 'ok';
let admins = { count: 2, windowDays: 30, recent: [] };
const plugin = http.createServer((req, res) => {
  if (!req.url.includes('rest_route')) {
    // La page d'accueil du faux site
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end('<html><head><title>Blog</title></head><body><h1>Blog</h1><p>Bienvenue</p><p>Articles</p><p>Contact</p><p>Mentions</p><p>Archives</p></body></html>');
  }
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${TOKEN}`) { res.writeHead(401); return res.end('no'); }
  if (req.url.includes('integrity')) {
    if (integrityMode === 'absent') { res.writeHead(404); return res.end('{"code":"rest_no_route"}'); }
    const clean = { known: true, checked: 10, modified: [], added: [], missing: [], more: 0 };
    const hacked = integrityMode === 'hacked';
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      cms: 'wordpress',
      integrity: {
        core: { ...clean, version: '6.8' },
        plugins: [{ name: 'Akismet', slug: 'akismet', version: '5.3', ...clean, modified: hacked ? ['class.akismet.php'] : [] }],
        uploads: { php: hacked ? ['2026/shell.php'] : [], more: 0, scanned: 40, truncated: false },
        partial: false,
      },
    }));
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    cms: 'wordpress', php: '8.3.14', cmsVersion: '6.8', core: { current: '6.8', available: null, known: true },
    extensions: [{ name: 'Akismet', slug: 'akismet', current: '5.3', available: null, active: true, known: true }], themes: [], admins,
  }));
});
await new Promise((r) => plugin.listen(0, '127.0.0.1', r));
const siteUrl = `http://127.0.0.1:${plugin.address().port}/`;
dbm.saveSettings({ telegram: { token: '123:ABC', chatId: '42', enabled: true, minSeverity: 'warning', sendRecovery: true, includeDiff: true } });
const watch = dbm.createWatch({ name: 'Blog', url: siteUrl, interval: 5, config: { checks: { dns: false, tls: false, rdap: false }, cms: { type: 'wordpress', token: TOKEN, intervalMin: 720 } } });
const types = (r) => r.alerts.map((a) => a.type);

test('relevé : plugin ancien (sans route d’intégrité) → versions relevées, erreur d’intégrité signalée sans alerte', async () => {
  integrityMode = 'absent';
  const r = await pollCms(watch.id, { refresh: true });
  assert.equal(r.ok, true, 'le relevé des versions n’échoue pas');
  assert.equal(r.cms.integrity.ok, false);
  assert.match(r.cms.integrity.error, /trop ancien/);
  assert.equal(r.cms.admins.baseCount, 2, 'référence des administrateurs fixée');
  const c = await runCheck(watch.id);
  assert.deepEqual(types(c), [], 'aucune alerte inventée');
  assert.equal(dbm.getWatch(watch.id).nextRun > 0, true);
});

test('moteur : fichiers modifiés et PHP dans uploads alertent une fois, puis « rétabli » quand tout est conforme', async () => {
  integrityMode = 'hacked';
  const before = sent.length;
  const r = await pollCms(watch.id, { refresh: true });
  assert.equal(r.cms.integrity.ok, true);
  assert.equal(dbm.getWatch(watch.id).nextRun, 0, 'le contrôle du site est relancé sans attendre');
  const c = await runCheck(watch.id);
  assert.deepEqual(types(c).sort(), ['cms_integrity_plugins', 'cms_integrity_uploads']);
  assert.deepEqual(c.alerts.map((a) => a.severity), ['critical', 'critical']);
  assert.equal(sent.length, before + 1, 'un seul message Telegram');
  assert.match(sent.at(-1).text, /shell\.php/);
  assert.deepEqual(types(await runCheck(watch.id)), [], 'pas de répétition');

  integrityMode = 'ok';
  await pollCms(watch.id, { refresh: true });
  const back = await runCheck(watch.id);
  assert.deepEqual(types(back), ['recovery', 'recovery']);
  assert.deepEqual(Object.keys(dbm.getWatch(watch.id).state.incidents), []);
});

test('moteur : un nouvel administrateur alerte, ré-alerte s’ils sont plus nombreux, et « Je connais ces comptes » le fait taire sans « rétabli »', async () => {
  admins = { count: 3, windowDays: 30, recent: [{ id: 9, login: 'pirate', registered: new Date().toISOString() }] };
  await pollCms(watch.id, { refresh: true });
  const c = await runCheck(watch.id);
  assert.deepEqual(types(c), ['cms_admins']);
  assert.equal(c.alerts[0].severity, 'critical');
  assert.match(c.alerts[0].title, /Nouvel administrateur : pirate/);
  assert.deepEqual(types(await runCheck(watch.id)), [], 'pas de répétition');

  admins = { count: 4, windowDays: 30, recent: [{ id: 9, login: 'pirate', registered: new Date().toISOString() }, { id: 10, login: 'second', registered: new Date().toISOString() }] };
  await pollCms(watch.id, { refresh: true });
  const more = await runCheck(watch.id);
  assert.deepEqual(types(more), ['cms_admins'], 'un 2e compte n’est pas passé sous silence');
  assert.match(more.alerts[0].title, /^2 nouveaux comptes administrateur \(2 → 4\)$/);

  const count = sent.length;
  assert.ok(acceptCmsAdmins(watch.id));
  assert.deepEqual(Object.keys(dbm.getWatch(watch.id).state.incidents), []);
  assert.deepEqual(types(await runCheck(watch.id)), [], 'accepté : silence, aucun message « rétabli »');
  assert.equal(sent.length, count);
  await pollCms(watch.id, { refresh: true });
  assert.deepEqual(types(await runCheck(watch.id)), [], 'et ils ne reviennent pas au relevé suivant');
  assert.equal(acceptCmsAdmins(99999), null);
});

test('moteur : contrôle de sécurité coupé pour ce site → incidents effacés en silence, mises à jour toujours évaluées', async () => {
  integrityMode = 'hacked';
  await pollCms(watch.id, { refresh: true });
  assert.deepEqual(types(await runCheck(watch.id)).sort(), ['cms_integrity_plugins', 'cms_integrity_uploads']);
  const count = sent.length;
  const cur = dbm.getWatch(watch.id);
  dbm.updateWatch(watch.id, { config: { ...cur.config, cms: { ...cur.config.cms, security: false } } });
  assert.deepEqual(types(await runCheck(watch.id)), []);
  assert.equal(sent.length, count, 'aucun « rétabli » trompeur');
  assert.deepEqual(Object.keys(dbm.getWatch(watch.id).state.incidents), []);
  const r = await pollCms(watch.id, { refresh: true });
  assert.equal('integrity' in r.cms, false, 'plus de contrôle d’intégrité demandé');
});

test.after(() => {
  plugin.close();
  fakeTelegram.close();
  dbm.db.close();
});
