import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Code suspect (plugins 1.3) : lecture bornée de la réponse, politique d'alerte, acquittement par empreinte, moteur de bout en bout.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'suricate-cmscode-'));
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

const { cmsIncidents, cmsIncidentGroup, carryCode, acceptCode, codeAlertFiles, CODE_LABELS } = await import('../src/cms-alerts.js');
const dbm = await import('../src/db.js');
const { parseCodeReport, cmsEndpoint, pollCms, acceptCmsCode } = await import('../src/cms.js');
const { runCheck } = await import('../src/checker.js');

const TOKEN = 'jeton-de-test-assez-long';
const NOW = Date.parse('2026-11-02T10:00:00Z');
const file = (path, level, origin, hash = 'aaaaaaaaaa', hits = ['eval_decode']) => ({ path, level, origin, hash, hits });
const rep = (files, extra = {}) => ({ cms: 'wordpress', core: {}, extensions: [], themes: [], code: carryCode(null, { enabled: true, files, more: 0, drift: { files: [], more: 0, days: 14 }, inventory: 10, baseline: false, partial: false, persistent: true, ...extra }, NOW) });

test('adresses : la route « code » du plugin, WordPress et PrestaShop', () => {
  assert.equal(cmsEndpoint('https://x.test/blog/', { type: 'wordpress', path: '' }, 'code'), 'https://x.test/?rest_route=/suricateweb/v1/code');
  assert.equal(cmsEndpoint('https://x.test/', { type: 'prestashop', path: 'boutique' }, 'code'), 'https://x.test/boutique/modules/suricateweb/status.php?scope=code');
  assert.equal(cmsEndpoint('https://x.test/', { type: 'prestashop', path: '' }), 'https://x.test/modules/suricateweb/status.php', 'les autres relevés ne changent pas');
});

test('réponse du plugin : chemins, motifs et empreintes bornés, jamais de contenu', () => {
  const c = parseCodeReport(JSON.stringify({
    cms: 'wordpress',
    code: {
      enabled: true, inventory: 12, baseline: true, partial: true, persistent: false, more: 3,
      files: [
        { path: 'wp-content/themes/x/a.php', level: 'strong', hits: ['eval_decode', 'Pas Valide!', 'long_line'], hash: 'ABCDEF0123', origin: 'change', content: '<?php eval(...)', excerpt: 'secret' },
        { path: 'b.php', level: 'inconnu', hits: [], hash: 'aaaaaaaaaa', origin: 'change' },
        { path: '', level: 'review', hits: [], hash: 'aaaaaaaaaa' },
        { path: 'wp-content/c.php', level: 'review', hits: ['goto_chain'], hash: '0123456789ab', origin: 'x' },
        ...Array.from({ length: 100 }, (_, k) => ({ path: `m/${k}.php`, level: 'vendor', hits: ['vendor_encoder'], hash: 'bbbbbbbbbb', origin: 'baseline' })),
      ],
      drift: { files: Array.from({ length: 80 }, (_, k) => `d${k}.php`), more: 5, days: 14 },
    },
  }), 'wordpress');
  assert.equal(c.enabled, true);
  assert.deepEqual(c.files[0], { path: 'wp-content/themes/x/a.php', level: 'strong', hits: ['eval_decode', 'long_line'], hash: '', origin: 'change' }, 'motif invalide écarté, empreinte non hexadécimale minuscule écartée, aucun champ de contenu');
  assert.equal(c.files.length, 60, 'liste bornée');
  assert.ok(!c.files.some((f) => f.path === 'b.php' || f.path === ''), 'niveau inconnu ou chemin vide écartés');
  assert.equal(c.files[1].origin, 'baseline', 'origine inconnue : « déjà là », jamais un changement inventé');
  assert.equal(c.drift.files.length, 50);
  assert.deepEqual([c.more, c.baseline, c.partial, c.persistent, c.inventory], [3, true, true, false, 12]);
  assert.ok(!JSON.stringify(c).includes('secret') && !JSON.stringify(c).includes('eval(...)'));
  assert.deepEqual(parseCodeReport({ cms: 'wordpress', code: { enabled: false } }, 'wordpress'), { enabled: false });
  assert.throws(() => parseCodeReport({ cms: 'wordpress', php: '8.3' }, 'wordpress'), /trop ancien/);
  assert.throws(() => parseCodeReport({ cms: 'prestashop', code: {} }, 'wordpress'), /invalide/);
});

test('politique d’alerte : fort + changement = critique ; fort déjà là, ou à relire + changement = attention ; le reste est seulement listé', () => {
  const sev = (files) => cmsIncidents(rep(files), { now: NOW }).map((i) => [i.key, i.severity]);
  assert.deepEqual(sev([file('a.php', 'strong', 'change')]), [['cms_integrity_code', 'critical']]);
  assert.deepEqual(sev([file('a.php', 'strong', 'baseline')]), [['cms_integrity_code', 'warning']]);
  assert.deepEqual(sev([file('a.php', 'review', 'change', 'bbbbbbbbbb', ['long_line', 'goto_chain'])]), [['cms_integrity_code', 'warning']]);
  assert.deepEqual(sev([file('a.php', 'review', 'baseline')]), [], 'à relire déjà présent à la première analyse : listé seulement');
  assert.deepEqual(sev([file('a.php', 'vendor', 'change', 'cccccccccc', ['vendor_encoder'])]), [], 'code chiffré par un éditeur : jamais d’alerte');
  assert.deepEqual(sev([file('a.php', 'review', 'baseline'), file('b.php', 'strong', 'change')]), [['cms_integrity_code', 'critical']], 'un seul incident, le plus grave l’emporte');
  assert.equal(cmsIncidentGroup('cms_integrity_code'), 'security', 'se coupe avec le contrôle de sécurité du site');
  assert.deepEqual(cmsIncidents(rep([file('a.php', 'strong', 'change')]), { now: NOW, security: false }), [], 'groupe sécurité coupé');
  assert.deepEqual(cmsIncidents({ ...rep([file('a.php', 'strong', 'change')]), code: { enabled: false } }, { now: NOW }), [], 'analyse coupée côté site');
  assert.deepEqual(cmsIncidents({ cms: 'wordpress', core: {}, code: { enabled: true, ok: false, error: 'Plugin trop ancien', files: [] } }, { now: NOW }), [], 'erreur de relevé : aucune alerte inventée');

  const [i] = cmsIncidents(rep([file('wp-content/themes/x/a.php', 'strong', 'change', 'aaaaaaaaaa', ['eval_decode', 'long_line'])]), { now: NOW });
  assert.equal(i.title, 'Code suspect : wp-content/themes/x/a.php');
  assert.match(i.detail, /code décodé puis exécuté/);
  assert.match(i.detail, /apparu ou modifié depuis la dernière analyse/);
  assert.match(i.detail, /Je connais ce fichier/);
  assert.equal(i.count, 1);
  assert.match(cmsIncidents(rep([file('a.php', 'strong', 'change'), file('b.php', 'strong', 'change')]), { now: NOW })[0].title, /^Code suspect dans 2 fichiers/);
});

test('acquittement : lié à l’empreinte (le fichier modifié redevient une alerte), conservé tant que le fichier est signalé', () => {
  const first = carryCode(null, rep([file('a.php', 'strong', 'change', 'aaaaaaaaaa')]).code, NOW);
  assert.equal(first.files[0].since, NOW);
  assert.equal(acceptCode(first, 'autre.php'), null, 'chemin inconnu : rien à reconnaître');
  const accepted = acceptCode(first);
  assert.equal(accepted.files[0].known, true);
  assert.deepEqual(accepted.acks, ['a.php:aaaaaaaaaa']);
  assert.equal(codeAlertFiles(accepted).length, 0);
  assert.equal(acceptCode(accepted), null, 'déjà reconnu');

  // Relevé suivant, même empreinte : reste reconnu, ancienneté conservée
  const again = carryCode(accepted, { ...first, files: [file('a.php', 'strong', 'baseline', 'aaaaaaaaaa')], checkedAt: NOW + 1 }, NOW + 1000);
  assert.equal(again.files[0].known, true);
  assert.equal(again.files[0].since, NOW);
  // Fichier modifié (autre empreinte) : alerte de nouveau
  const edited = carryCode(again, { ...first, files: [file('a.php', 'strong', 'change', 'dddddddddd')] }, NOW + 2000);
  assert.equal(edited.files[0].known, false);
  assert.equal(codeAlertFiles(edited).length, 1);
  assert.deepEqual(edited.acks, [], 'acquittement d’une ancienne empreinte abandonné');
  // Relevé partiel : on garde les acquittements des fichiers non revus
  assert.deepEqual(carryCode(accepted, { ...first, files: [], partial: true }, NOW + 3000).acks, ['a.php:aaaaaaaaaa']);
  // Un fichier chiffré par un éditeur ne se « reconnaît » pas (rien à reconnaître)
  assert.equal(acceptCode(rep([file('v.php', 'vendor', 'baseline', 'eeeeeeeeee', ['vendor_encoder'])]).code), null);
});

test('libellés : chaque motif connu du scanner a son texte', () => {
  const src = readFileSync(new URL('../plugins/wordpress/suricateweb/scanner.php', import.meta.url), 'utf8');
  const ids = new Set([...src.matchAll(/^\s{8}'([a-z_]+)' => array\(\d+,/gm)].map((m) => m[1]));
  for (const m of src.matchAll(/\$hits\['([a-z_]+)'\]\s*=/g)) ids.add(m[1]);
  ids.add('vendor_encoder');
  assert.ok(ids.size >= 17, `règles trouvées : ${[...ids].join(', ')}`);
  for (const id of ids) assert.ok(CODE_LABELS[id], `libellé manquant (alertes) : ${id}`);
  const ui = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  for (const id of ids) assert.ok(ui.includes(`${id}:`), `libellé manquant (interface) : ${id}`);
});

// ── Moteur de bout en bout, contre un faux plugin ──
let codeFiles = [];
let codeRequests = 0;
const plugin = http.createServer((req, res) => {
  if (!req.url.includes('rest_route')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end('<html><head><title>Blog</title></head><body><h1>Blog</h1><p>Bienvenue</p><p>Articles</p><p>Contact</p><p>Mentions</p><p>Archives</p></body></html>');
  }
  if ((req.headers.authorization || '') !== `Bearer ${TOKEN}`) { res.writeHead(401); return res.end('no'); }
  res.writeHead(200, { 'content-type': 'application/json' });
  if (req.url.includes('/code')) {
    codeRequests++;
    return res.end(JSON.stringify({ cms: 'wordpress', code: { enabled: true, files: codeFiles, more: 0, drift: { files: [], more: 0, days: 14 }, inventory: 40, baseline: false, partial: false, persistent: true } }));
  }
  if (req.url.includes('integrity')) {
    const clean = { known: true, checked: 10, modified: [], added: [], missing: [], more: 0 };
    return res.end(JSON.stringify({ cms: 'wordpress', integrity: { core: { ...clean, version: '6.8' }, plugins: [], uploads: { php: [], more: 0, scanned: 40, truncated: false }, partial: false } }));
  }
  res.end(JSON.stringify({ cms: 'wordpress', php: '8.3.14', cmsVersion: '6.8', core: { current: '6.8', available: null, known: true }, extensions: [], themes: [], admins: { count: 1, windowDays: 30, recent: [] } }));
});
await new Promise((r) => plugin.listen(0, '127.0.0.1', r));
await dbm.saveSettings({ telegram: { token: '123:ABC', chatId: '42', enabled: true, minSeverity: 'warning', sendRecovery: true, includeDiff: true } });
const watch = await dbm.createWatch({ name: 'Blog', url: `http://127.0.0.1:${plugin.address().port}/`, interval: 5, config: { checks: { dns: false, tls: false, rdap: false }, cms: { type: 'wordpress', token: TOKEN, intervalMin: 720 } } });
const types = (r) => r.alerts.map((a) => a.type);

test('réglage : la recherche de code suspect est active par défaut et se coupe site par site', () => {
  assert.equal(watch.config.cms.codeScan, true);
  assert.equal(dbm.normalizeConfig({ cms: { type: 'wordpress', codeScan: false } }).cms.codeScan, false);
  assert.equal(dbm.normalizeConfig({ cms: { type: 'wordpress' } }).cms.codeScan, true);
});

test('moteur : un fichier à motif fort alerte une fois ; « Je connais ce fichier » le fait taire sans « rétabli » ; une modification relance l’alerte', async () => {
  const r0 = await pollCms(watch.id, { refresh: true });
  assert.equal(r0.cms.code.ok, true);
  assert.deepEqual(types(await runCheck(watch.id)), [], 'site propre');

  codeFiles = [file('wp-content/themes/x/header.php', 'strong', 'change', 'aaaaaaaaaa')];
  const before = sent.length;
  await pollCms(watch.id, { refresh: true });
  const c = await runCheck(watch.id);
  assert.deepEqual(types(c), ['cms_integrity_code']);
  assert.equal(c.alerts[0].severity, 'critical');
  assert.equal(sent.length, before + 1);
  assert.match(sent.at(-1).text, /header\.php/);
  assert.deepEqual(types(await runCheck(watch.id)), [], 'pas de répétition');

  const count = sent.length;
  assert.ok(await acceptCmsCode(watch.id, 'wp-content/themes/x/header.php'));
  assert.deepEqual(Object.keys((await dbm.getWatch(watch.id)).state.incidents), []);
  assert.deepEqual(types(await runCheck(watch.id)), [], 'reconnu : silence, aucun message « rétabli »');
  await pollCms(watch.id, { refresh: true });
  assert.deepEqual(types(await runCheck(watch.id)), [], 'et il ne revient pas au relevé suivant');
  assert.equal(sent.length, count);
  assert.equal(await acceptCmsCode(watch.id, 'wp-content/themes/x/header.php'), null, 'déjà reconnu');
  assert.equal(await acceptCmsCode(99999), null);

  codeFiles = [file('wp-content/themes/x/header.php', 'strong', 'change', 'bbbbbbbbbb')];
  await pollCms(watch.id, { refresh: true });
  assert.deepEqual(types(await runCheck(watch.id)), ['cms_integrity_code'], 'fichier modifié depuis : alerte de nouveau');

  codeFiles = [];
  await pollCms(watch.id, { refresh: true });
  assert.deepEqual(types(await runCheck(watch.id)), ['recovery'], 'fichier nettoyé : rétabli');
});

test('moteur : plugin sans route « code » → versions et intégrité relevées, erreur signalée sans alerte, dernier résultat conservé', async () => {
  codeFiles = [file('a.php', 'review', 'baseline', 'cccccccccc', ['long_line', 'goto_chain'])];
  const ok = await pollCms(watch.id, { refresh: true });
  assert.equal(ok.cms.code.files.length, 1, 'à relire déjà présent : listé');
  assert.deepEqual(types(await runCheck(watch.id)), [], 'mais sans alerte');
  const saved = plugin.listeners('request')[0];
  plugin.removeAllListeners('request');
  plugin.on('request', (req, res) => {
    if (req.url.includes('/code')) { res.writeHead(404); return res.end('{"code":"rest_no_route"}'); }
    return saved(req, res);
  });
  const r = await pollCms(watch.id, { refresh: true });
  assert.equal(r.ok, true);
  assert.equal(r.cms.code.ok, false);
  assert.match(r.cms.code.error, /trop ancien/);
  assert.equal(r.cms.code.files.length, 1, 'dernier résultat réussi conservé');
  assert.equal(r.cms.integrity.ok, true, 'l’intégrité n’est pas touchée');
  plugin.removeAllListeners('request');
  plugin.on('request', saved);
});

test('moteur : recherche coupée pour ce site → aucune requête « code », rien dans le relevé, incident effacé', async () => {
  codeFiles = [file('wp-content/themes/x/h.php', 'strong', 'change', 'dddddddddd')];
  await pollCms(watch.id, { refresh: true });
  assert.deepEqual(types(await runCheck(watch.id)), ['cms_integrity_code']);
  const cur = await dbm.getWatch(watch.id);
  await dbm.updateWatch(watch.id, { config: { ...cur.config, cms: { ...cur.config.cms, codeScan: false } } });
  const asked = codeRequests;
  const r = await pollCms(watch.id, { refresh: true });
  assert.equal(codeRequests, asked, 'le plugin n’est pas interrogé');
  assert.equal('code' in r.cms, false);
  await runCheck(watch.id);
  assert.deepEqual(Object.keys((await dbm.getWatch(watch.id)).state.incidents), []);
});

test.after(() => {
  plugin.close();
  fakeTelegram.close();
  dbm.db.close();
});
