import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Environnement isolé : base temporaire + faux serveur Telegram.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'vigie-'));

const sent = [];
const fakeTelegram = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    if (req.url.endsWith('/sendMessage')) sent.push(JSON.parse(b));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, result: req.url.endsWith('/getMe') ? { username: 'vigie_test_bot' } : {} }));
  });
});
await new Promise((r) => fakeTelegram.listen(0, '127.0.0.1', r));
process.env.TELEGRAM_API = `http://127.0.0.1:${fakeTelegram.address().port}`;

const { parseHtml, selectAll, textLines, extractFeatures } = await import('../src/html.js');
const { diffLines } = await import('../src/diff.js');
const { registrable, clamp } = await import('../src/util.js');

test('clamp() : un paramètre absent prend la valeur par défaut, pas le minimum', () => {
  assert.equal(clamp(null, 1, 500, 200), 200, 'paramètre de requête absent');
  assert.equal(clamp(undefined, 1, 500, 200), 200);
  assert.equal(clamp('', 1, 500, 200), 200);
  assert.equal(clamp('abc', 1, 500, 200), 200);
  assert.equal(clamp('0', 1, 500, 200), 1, 'un 0 explicite est bien borné');
  assert.equal(clamp(9999, 1, 500, 200), 500);
  assert.equal(clamp('60', 1, 500, 200), 60);
  assert.equal(clamp(-60, -840, 840, 0), -60, 'décalage horaire négatif');
});
const dbm = await import('../src/db.js');
const { runCheck, wordIndex } = await import('../src/checker.js');

test('mots-clés : mot entier uniquement (« cialis » ≠ « spécialisées »)', () => {
  assert.equal(wordIndex('des équipes spécialisées et dédiées', 'cialis'), -1);
  assert.equal(wordIndex('entreprise spécialisée', 'cialis'), -1);
  assert.equal(wordIndex('achetez cialis pas cher', 'cialis'), 8);
  assert.ok(wordIndex('promo: Cialis, viagra!'.toLowerCase(), 'viagra') > 0, 'ponctuation = frontière de mot');
  assert.ok(wordIndex('page hacked by evil crew', 'hacked by') > 0, 'expressions de plusieurs mots');
  assert.ok(wordIndex('<index of /> répertoire', 'index of /') >= 0, 'caractères spéciaux échappés');
  assert.equal(wordIndex('piraté', 'pirat'), -1);
  assert.ok(wordIndex('site piraté par x', 'piraté par') >= 0, 'accents');
});

test('registrable()', () => {
  assert.equal(registrable('www.example.fr'), 'example.fr');
  assert.equal(registrable('a.b.example.co.uk'), 'example.co.uk');
  assert.equal(registrable('127.0.0.1'), '127.0.0.1');
});

test('parseur HTML, sélecteurs et texte', () => {
  const root = parseHtml(`<html><head><title>Ma &amp; Page</title><script>var x="<div>";</script></head>
    <body><div id="main" class="a b"><p>Bonjour<br>monde &eacute;t&eacute;</p><ul><li>un<li>deux</ul></div>
    <div class="ads">PUB</div><a href="https://evil.example.net/x">x</a><iframe src="//spam.test/f"></iframe>
    <script src="/app.js?v=3"></script><script>eval(atob("${'A'.repeat(10)}"))</script></body></html>`);
  assert.equal(selectAll(root, '#main p').length, 1);
  assert.equal(selectAll(root, 'div.a.b > p').length, 1);
  assert.equal(selectAll(root, 'li, .ads').length, 3);
  const lines = textLines(selectAll(root, '#main'));
  assert.deepEqual(lines, ['Bonjour', 'monde été', 'un', 'deux']);
  const f = extractFeatures(root, 'https://www.example.fr/');
  assert.equal(f.title, 'Ma & Page');
  assert.deepEqual(f.scripts, ['https://www.example.fr/app.js']);
  assert.deepEqual(f.linkHosts, ['evil.example.net']);
  assert.deepEqual(f.iframeHosts, ['spam.test']);
  assert.equal(f.suspects.length, 1);
  assert.throws(() => selectAll(root, 'a:hover'));
});

test('diff de lignes', () => {
  const d = diffLines(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e']);
  assert.equal(d.added, 2);
  assert.equal(d.removed, 1);
  assert.ok(d.similarity > 0.6 && d.similarity < 0.8);
  assert.equal(diffLines([], []).similarity, 1);
});

// ───────────── Scénario complet : un site qui se fait pirater ─────────────

let page = { code: 200, html: '', headers: {} };
const site = http.createServer((req, res) => {
  if (page.drop) return req.socket.destroy();
  // La destination d'une redirection (hôte « localhost ») répond toujours 200.
  const redirected = req.headers.host.startsWith('localhost');
  res.writeHead(redirected ? 200 : page.code, { 'content-type': 'text/html; charset=utf-8', ...(redirected ? {} : page.headers) });
  res.end(redirected ? '<html><body>ailleurs</body></html>' : page.html);
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const siteUrl = `http://127.0.0.1:${site.address().port}/`;

const home = (extra = '', title = 'Boutique Dupont') => `<!doctype html><html><head><title>${title}</title></head><body>
  <h1>Bienvenue chez Dupont</h1><p>Artisan depuis 1987.</p><p>Contactez-nous au 01 02 03 04 05</p>
  <p>Nos produits</p><p>Notre histoire</p><p>Mentions légales</p>${extra}
  <script src="/static/app.js"></script></body></html>`;

dbm.saveSettings({ telegram: { token: '123:ABC', chatId: '42', enabled: true, minSeverity: 'warning', sendRecovery: true, includeDiff: true } });
page.html = home();
const w = dbm.createWatch({ name: 'Boutique', url: siteUrl, interval: 5, config: { checks: { dns: false, tls: false, rdap: false }, failThreshold: 2 } });
const types = (r) => r.alerts.map((a) => a.type);

test('1er passage = référence, aucune alerte', async () => {
  const r = await runCheck(w.id);
  assert.equal(r.code, 200);
  assert.deepEqual(types(r), []);
  assert.equal(sent.length, 0);
});

test('passage sans changement = silence', async () => {
  assert.deepEqual(types(await runCheck(w.id)), []);
});

test('modification de contenu → alerte + Telegram avec diff', async () => {
  page.html = home('<p>Nouvelle promotion</p>');
  const r = await runCheck(w.id);
  assert.deepEqual(types(r), ['content_changed']);
  assert.equal(r.alerts[0].severity, 'warning');
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Nouvelle promotion/);
  assert.equal(sent[0].chat_id, '42');
});

test('défiguration : remplacement total + mot-clé + script + iframe + titre', async () => {
  page.html = `<html><head><title>HACKED</title></head><body><h1>Hacked by Evil Crew</h1><p>greetz to all</p>
    <iframe src="http://malware.example.net/x"></iframe><script src="http://cdn.evil.example.net/p.js"></script></body></html>`;
  const r = await runCheck(w.id);
  const t = types(r);
  for (const x of ['content_changed', 'forbidden', 'title_changed', 'script_added', 'iframe_added']) assert.ok(t.includes(x), `manque ${x} dans ${t}`);
  assert.equal(r.alerts.find((a) => a.type === 'content_changed').severity, 'critical');
  assert.equal(sent.length, 2, 'un seul message Telegram groupé pour ce passage');
  assert.match(sent.at(-1).text, /CRITIQUE/);
});

test('l’incident ne spamme pas, puis « rétabli » à la restauration', async () => {
  assert.deepEqual(types(await runCheck(w.id)), []);
  page.html = home('<p>Nouvelle promotion</p>');
  const r = await runCheck(w.id);
  assert.ok(types(r).includes('recovery'));
  assert.match(sent.at(-1).text, /Rétabli|RÉTABLI/);
});

test('redirection vers un autre domaine', async () => {
  page.code = 302;
  page.headers = { location: 'http://localhost:' + site.address().port + '/' };
  page.html = '';
  const r = await runCheck(w.id);
  assert.ok(types(r).includes('redirect_domain'), types(r).join());
  page.code = 200;
  page.headers = {};
  page.html = home('<p>Nouvelle promotion</p>');
  await runCheck(w.id);
});

test('site injoignable : alerte seulement après 2 échecs, puis rétabli', async () => {
  page.drop = true;
  assert.deepEqual(types(await runCheck(w.id)), []);
  const r = await runCheck(w.id);
  assert.deepEqual(types(r), ['down']);
  page.drop = false;
  assert.ok(types(await runCheck(w.id)).includes('recovery'));
});

test('faux positif « spécialisées » : aucun incident ; vrai spam : incident', async () => {
  const w2 = dbm.createWatch({ name: 'Faux positif', url: siteUrl, interval: 5, config: { checks: { dns: false, tls: false, rdap: false } } });
  page.html = home('<p>Des équipes spécialisées. Nos techniciens sont spécialisés.</p>');
  assert.deepEqual(types(await runCheck(w2.id)), []);
  assert.deepEqual(Object.keys(dbm.getWatch(w2.id).state.incidents), []);
  page.html = home('<p>Buy Cialis online</p>');
  assert.ok(types(await runCheck(w2.id)).includes('forbidden'));
  page.html = home('<p>Nouvelle promotion</p>');
});

test('texte requis absent', async () => {
  dbm.updateWatch(w.id, { config: { ...dbm.getWatch(w.id).config, required: ['Artisan depuis 1987'] } });
  assert.deepEqual(types(await runCheck(w.id)), []);
  page.html = home().replace('Artisan depuis 1987.', 'Page en maintenance');
  assert.ok(types(await runCheck(w.id)).includes('required'));
});

test.after(() => {
  site.close();
  fakeTelegram.close();
  dbm.db.close();
});
