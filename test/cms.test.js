import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'vigie-cms-'));

const { normalizeConfig, createWatch, getWatch } = await import('../src/db.js');
const { cmsEndpoint, cmsConfigError, parseCmsReport, pollCms } = await import('../src/cms.js');
const { zipDirectory } = await import('../src/zip.js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'jeton-de-test-assez-long';

test('config CMS : défauts, domaine seul, chemin invalide', () => {
  const d = normalizeConfig({});
  assert.deepEqual(d.cms, { type: '', token: '', path: '', intervalMin: 720 });
  const wp = normalizeConfig({ cms: { type: 'wordpress', token: TOKEN, path: '/blog/', intervalMin: 10 } });
  assert.equal(wp.cms.type, 'wordpress');
  assert.equal(wp.cms.path, 'blog');
  assert.equal(wp.cms.intervalMin, 60);
  assert.equal(normalizeConfig({ mode: 'domain', cms: { type: 'prestashop', token: TOKEN } }).cms.type, '');
  assert.equal(cmsConfigError({ type: 'wordpress', token: 'court', path: '' }), 'Le jeton doit contenir au moins 16 caractères');
  assert.equal(cmsConfigError({ type: 'wordpress', token: TOKEN, path: '../secret' }), 'Le chemin du CMS est invalide');
  assert.equal(cmsConfigError({ type: '', token: '', path: '' }), null);
});

test('adresse du plugin : origine du site, chemin fixe', () => {
  assert.equal(
    cmsEndpoint('https://www.exemple.fr/page', { type: 'wordpress', path: '' }),
    'https://www.exemple.fr/?rest_route=/vigieweb/v1/status',
  );
  assert.equal(
    cmsEndpoint('https://shop.exemple.fr/fr/', { type: 'prestashop', path: 'boutique' }),
    'https://shop.exemple.fr/boutique/modules/vigieweb/status.php',
  );
  assert.equal(cmsEndpoint('https://exemple.fr/', { type: 'wordpress', path: '../x' }), null);
  assert.equal(cmsEndpoint('ftp://exemple.fr/', { type: 'wordpress', path: '' }), null);
});

test('réponse du plugin : versions bornées, CMS inattendu rejeté', () => {
  const r = parseCmsReport(JSON.stringify({
    cms: 'wordpress', php: '8.2.27', cmsVersion: '6.7.1',
    core: { current: '6.7.1', available: '6.8', known: true },
    extensions: [
      { name: 'Akismet', slug: 'akismet', current: '5.3', available: '5.4', active: true },
      { name: 'Ok', slug: 'ok', current: '1.0', available: null, active: false, known: true },
      { name: '<script>', slug: 'x', current: 'pas une version', available: '1.2.3; rm', active: true },
    ],
    themes: [{ name: 'Twenty', slug: 'twentytwentyfour', current: '1.3', available: null, known: false }],
  }), 'wordpress');
  assert.equal(r.php, '8.2.27');
  assert.equal(r.core.available, '6.8');
  assert.equal(r.extensions.length, 3);
  assert.equal(r.extensions[0].available, '5.4');
  assert.equal(r.extensions[2].current, null);
  assert.equal(r.extensions[2].available, null);
  assert.equal(r.extensions[2].name, '<script>');
  assert.equal(r.themes[0].known, false);
  assert.throws(() => parseCmsReport('{"cms":"prestashop"}', 'wordpress'));
  assert.throws(() => parseCmsReport('non', 'wordpress'), SyntaxError);
});

test('zip des plugins : dossier vigieweb/ et sources en clair', () => {
  for (const dir of ['wordpress', 'prestashop']) {
    const buf = zipDirectory(join(ROOT, 'plugins', dir, 'vigieweb'), 'vigieweb');
    assert.equal(buf.readUInt32LE(0), 0x04034b50);
    const text = buf.toString('utf8');
    assert.match(text, /vigieweb\/vigieweb\.php/);
    assert.match(text, /PHP_VERSION/);
  }
});

test('relevé : jeton accepté, redirection vers un autre domaine refusée, JSON invalide', async () => {
  let evilHits = 0;
  const evil = http.createServer((req, res) => {
    evilHits++;
    res.end('no');
  });
  await new Promise((r) => evil.listen(0, '127.0.0.1', r));
  const evilPort = evil.address().port;

  const plugin = http.createServer((req, res) => {
    if (req.url.startsWith('/hop')) {
      res.writeHead(302, { location: `http://127.0.0.1:${evilPort}/secret` });
      res.end();
      return;
    }
    if (req.url.startsWith('/bad')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('pas-du-json');
      return;
    }
    const auth = req.headers.authorization || '';
    const alt = req.headers['x-vigie-token'] || '';
    if (auth !== `Bearer ${TOKEN}` && alt !== TOKEN) {
      res.writeHead(401);
      res.end('no');
      return;
    }
    assert.equal(req.headers.authorization?.includes(TOKEN), true);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      cms: 'wordpress', php: '8.3.1', cmsVersion: '6.8',
      core: { current: '6.8', available: null, known: true },
      extensions: [{ name: 'Classic', slug: 'classic', current: '1.0', available: '1.1', active: true }],
      themes: [],
    }));
  });
  await new Promise((r) => plugin.listen(0, '127.0.0.1', r));
  const port = plugin.address().port;
  try {
    const ok = createWatch({
      name: 'Blog', url: `http://127.0.0.1:${port}/`, interval: 15,
      config: { cms: { type: 'wordpress', token: TOKEN, path: '', intervalMin: 720 }, checks: { dns: false, rdap: false, tls: false } },
    });
    const r = await pollCms(ok.id, { refresh: true });
    assert.equal(r.ok, true);
    assert.equal(r.cms.php, '8.3.1');
    assert.equal(r.cms.extensions[0].available, '1.1');
    const saved = getWatch(ok.id);
    assert.equal(saved.state.cms.ok, true);
    assert.ok(saved.nextCms > Date.now());

    const refused = createWatch({
      name: 'Mauvais jeton', url: `http://127.0.0.1:${port}/`, interval: 15,
      config: { cms: { type: 'wordpress', token: 'autre-jeton-tres-long', path: '', intervalMin: 720 } },
    });
    const bad = await pollCms(refused.id);
    assert.equal(bad.ok, false);
    assert.match(bad.error, /refusé/);
    assert.equal(getWatch(refused.id).state.cms.ok, false);

    const hop = createWatch({
      name: 'Redirect', url: `http://127.0.0.1:${port}/hop`, interval: 15,
      config: { cms: { type: 'wordpress', token: TOKEN, path: 'hop', intervalMin: 60 } },
    });
    // Le chemin « hop » produit /hop/?rest_route=… : on force l'URL de départ via un chemin qui redirige.
    const hopResult = await pollCms(hop.id);
    assert.equal(hopResult.ok, false);
    assert.match(hopResult.error, /autre domaine/);
    assert.equal(evilHits, 0);

    const broken = createWatch({
      name: 'JSON', url: `http://127.0.0.1:${port}/bad`, interval: 15,
      config: { cms: { type: 'wordpress', token: TOKEN, path: 'bad', intervalMin: 60 } },
    });
    const junk = await pollCms(broken.id);
    assert.equal(junk.ok, false);
    assert.equal(junk.error, 'Réponse invalide');
  } finally {
    plugin.close();
    evil.close();
  }
});
