import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'vigie-shot-'));
// Dossier temporaire propre à ce test : les profils Chrome y sont créés, ce qui permet de vérifier qu'aucun ne traîne
// SANS être trompé par un autre VigieWeb qui capturerait au même moment sur la machine.
const TEST_TMP = mkdtempSync(join(tmpdir(), 'vigie-tmp-'));
process.env.TMPDIR = TEST_TMP;

// Faux serveur Telegram : enregistre le texte envoyé ET les photos (multipart).
const sent = [];
const telegram = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const kind = req.url.split('/').pop();
    if (kind === 'sendMessage') sent.push({ kind, text: JSON.parse(body).text });
    if (kind === 'sendPhoto') sent.push({ kind, multipart: /^multipart\/form-data/.test(req.headers['content-type'] || ''), bytes: body.length, body: body.toString('latin1') });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, result: {} }));
  });
});
await new Promise((r) => telegram.listen(0, '127.0.0.1', r));
process.env.TELEGRAM_API = `http://127.0.0.1:${telegram.address().port}`;

const dbm = await import('../src/db.js');
const shots = await import('../src/screenshot.js');
const { runCheck, hooks } = await import('../src/checker.js');
const { engine } = shots;

const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000ffdb00430008060607060508070707090908', 'hex');
const noNet = { checks: { dns: false, tls: false, rdap: false } };

// ───────────── Configuration ─────────────

test('config : les réglages de capture sont bornés', () => {
  const c = dbm.normalizeConfig({ screenshot: { interval: 1, width: 99999, height: 10, fullPage: 1 } });
  assert.deepEqual(c.screenshot, { enabled: true, interval: 5, fullPage: true, width: 1920, height: 400, delay: 3, interact: true, hideBanners: true, keep: 0 });
  assert.equal(dbm.normalizeConfig({}).screenshot.interval, 60);
  assert.deepEqual(dbm.normalizeConfig({ screenshot: { delay: 999, interact: false, hideBanners: false } }).screenshot.delay, 30, 'attente plafonnée à 30 s');
  assert.equal(dbm.normalizeConfig({ screenshot: { delay: -5 } }).screenshot.delay, 0);
  const off = dbm.normalizeConfig({ screenshot: { interact: false, hideBanners: false } }).screenshot;
  assert.deepEqual([off.interact, off.hideBanners], [false, false]);
  assert.equal(dbm.normalizeConfig({ screenshot: { enabled: false } }).screenshot.enabled, false);
  assert.equal(dbm.normalizeConfig({ screenshot: 'n\'importe quoi' }).screenshot.enabled, true);
});

// ───────────── Vrai navigateur (ignoré si Chrome n'est pas installé) ─────────────

test('Chrome réel : capture JPEG + miniature, erreurs lisibles, aucun processus ni profil laissé', { skip: !shots.chromePath() && 'Chrome/Chromium introuvable' }, async () => {
  const site = http.createServer((q, r) => {
    r.setHeader('content-type', 'text/html; charset=utf-8');
    r.end('<html><body style="margin:0;background:#c00"><h1 style="font:48px sans-serif;color:#fff">Rouge</h1><div style="height:2500px"></div><script>alert("x")</script></body></html>');
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${site.address().port}/`;
  try {
    const a = await shots.capture(url, { width: 800, height: 600, settleMs: 200 });
    assert.equal(a.image.subarray(0, 3).toString('hex'), 'ffd8ff', 'JPEG');
    assert.deepEqual([a.width, a.height], [800, 600]);
    assert.ok(a.thumb.length < a.image.length, 'la miniature est plus légère');

    const full = await shots.capture(url, { width: 800, height: 600, fullPage: true, settleMs: 200 });
    assert.ok(full.height > 2000 && full.height <= 5000, `page entière : ${full.height}px`);

    await assert.rejects(shots.capture('http://domaine-inexistant-vigie.invalid/', { settleMs: 0 }), /introuvable \(DNS\)/);
    await assert.rejects(shots.capture(`http://127.0.0.1:${site.address().port + 1}/`, { settleMs: 0 }), /refusée/);
  } finally {
    site.close();
  }
  const { execSync } = await import('node:child_process');
  const { readdirSync } = await import('node:fs');
  assert.equal(execSync(`pgrep -f '${TEST_TMP}/vigie-chrome-' || true`).toString().trim(), '', 'aucun Chrome orphelin');
  assert.deepEqual(readdirSync(TEST_TMP).filter((n) => n.startsWith('vigie-chrome-')), [], 'aucun profil temporaire laissé');
});

// Cas réel (burotica.fr, WP Rocket) : un site dont le JavaScript ne démarre qu'à la 1re interaction d'un visiteur
// laissait un bandeau d'accueil vide sur la capture. Le faux site rapporte, par requêtes « balises », ce que le navigateur a fait.
test('Chrome réel : scripts retardés jusqu\'à l\'interaction, défilement, bandeau de cookies', { skip: !shots.chromePath() && 'Chrome/Chromium introuvable' }, async () => {
  let hits = [];
  const site = http.createServer((q, r) => {
    if (q.url.startsWith('/__')) { hits.push(q.url); r.writeHead(204); return r.end(); }
    r.setHeader('content-type', 'text/html; charset=utf-8');
    r.end(`<html><body style="margin:0"><div style="height:3000px">page haute</div><script>
      const beacon = (p) => fetch(p);
      for (const ev of ['mousemove', 'wheel', 'keydown', 'touchstart']) addEventListener(ev, (e) => beacon('/__interacted?trusted=' + e.isTrusted), { once: true });
      addEventListener('scroll', () => beacon('/__scrolled'), { once: true });
      setTimeout(() => { const b = document.createElement('div'); b.id = 'cmplz-cookiebanner-container'; b.textContent = 'cookies'; document.body.append(b);
        // lu tard : le masquage est posé après le chargement de la page, pas avant
        setTimeout(() => beacon('/__banner?display=' + getComputedStyle(b).display), 1500); }, 300);
    </script></body></html>`);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${site.address().port}/`;
  const run = async (opt) => { hits = []; await shots.capture(url, { width: 800, height: 600, settleMs: 700, ...opt }); return hits; };
  try {
    const on = await run({ interact: true, hideBanners: true });
    assert.ok(on.includes('/__interacted?trusted=true'), `une VRAIE interaction (isTrusted) est attendue : ${on}`);
    assert.ok(on.includes('/__scrolled'), 'la page est défilée');
    assert.ok(on.includes('/__banner?display=none'), 'le bandeau de cookies est masqué');

    const off = await run({ interact: false, hideBanners: false });
    assert.ok(!off.some((h) => h.startsWith('/__interacted')), 'sans simulation, aucune interaction (les scripts retardés ne démarreraient pas)');
    assert.ok(off.includes('/__scrolled'), 'le défilement, lui, reste actif');
    assert.ok(off.includes('/__banner?display=block'), 'bandeau conservé si l\'option est coupée');
  } finally {
    site.close();
  }
});

// ───────────── Cycle de vie (moteur simulé) ─────────────

let calls = 0;
let failWith = null;
engine.available = () => true;
engine.capture = async () => {
  calls++;
  await new Promise((r) => setTimeout(r, 20));
  if (failWith) throw new Error(failWith);
  return { image: JPEG, thumb: JPEG.subarray(0, 20), width: 1280, height: 800, finalUrl: 'https://autre.example/accueil', title: 'Page de l’hébergeur' };
};

test('capture : fichiers + ligne + prochaine échéance ; dédoublonnage des captures simultanées', async () => {
  const w = await dbm.createWatch({ name: 'Cap', url: 'https://cap.test/', interval: 5, config: { ...noNet, screenshot: { interval: 30 } } });
  calls = 0;
  const [a, b] = await Promise.all([shots.captureWatch(w.id), shots.captureWatch(w.id)]);
  assert.equal(calls, 1, 'une seule capture réelle pour deux demandes simultanées');
  assert.equal(a.id, b.id);
  assert.equal((await shots.shotFiles(w.id)).length, 2, 'image + miniature');
  const [row] = await dbm.listScreenshots(w.id);
  assert.equal(row.kind, 'scheduled');
  assert.equal(row.finalUrl, 'https://autre.example/accueil', 'adresse réellement capturée conservée');
  assert.equal(row.title, 'Page de l’hébergeur');
  const after = await dbm.getWatch(w.id);
  assert.ok(Math.abs(after.nextShot - (a.ts + 30 * 60e3)) < 1000, 'prochaine capture dans 30 min');
  assert.equal(after.shotError, null);
  assert.equal((await dbm.latestScreenshots())[w.id].id, a.id);
});

test('capture : échec enregistré sur le site, nouvelle tentative plus tôt, aucune ligne créée', async () => {
  const w = await dbm.createWatch({ name: 'Echec', url: 'https://echec.test/', interval: 5, config: { ...noNet, screenshot: { interval: 360 } } });
  failWith = 'Connexion refusée par le serveur';
  const r = await shots.captureWatch(w.id);
  failWith = null;
  assert.equal(r.error, 'Connexion refusée par le serveur');
  assert.equal((await dbm.listScreenshots(w.id)).length, 0);
  const after = await dbm.getWatch(w.id);
  assert.equal(after.shotError, 'Connexion refusée par le serveur');
  assert.ok(after.nextShot - Date.now() <= 30 * 60e3 + 1000, 'nouvelle tentative sous 30 min, pas dans 6 h');
  const ok = await shots.captureWatch(w.id);
  assert.ok(ok.id);
  assert.equal((await dbm.getWatch(w.id)).shotError, null, "l'erreur disparaît au succès");
});

test('rétention : planifiées limitées, manuelles et d\'alerte conservées à part, fichiers supprimés', async () => {
  await dbm.saveSettings({ retention: { screenshots: 3 } });
  const w = await dbm.createWatch({ name: 'Ret', url: 'https://ret.test/', interval: 5, config: noNet });
  const ids = [];
  for (let i = 0; i < 6; i++) {
    ids.push((await shots.captureWatch(w.id)).id);
    await new Promise((r) => setTimeout(r, 3)); // horodatages (et noms de fichiers) distincts
  }
  const manual = (await shots.captureWatch(w.id, { kind: 'manual' })).id;
  const rows = await dbm.listScreenshots(w.id);
  assert.equal(rows.filter((r) => r.kind === 'scheduled').length, 3, '3 planifiées conservées');
  assert.deepEqual(rows.filter((r) => r.kind === 'scheduled').map((r) => r.id), ids.slice(-3).reverse(), 'les plus récentes');
  assert.ok(rows.some((r) => r.id === manual), 'la capture manuelle est conservée');
  assert.equal((await shots.shotFiles(w.id)).length, 4 * 2, '4 captures × (image + miniature) : les anciennes sont effacées du disque');

  await shots.removeWatchShots(w.id);
  assert.equal((await shots.shotFiles(w.id)).length, 0);
});

// ───────────── Photo Telegram sur alerte critique ─────────────

await dbm.saveSettings({ telegram: { token: '123:ABC', chatId: '42', enabled: true, minSeverity: 'warning', sendRecovery: true, includeDiff: true, sendScreenshot: true } });
let page = '<html><head><title>Site</title></head><body><h1>Bienvenue</h1><p>Artisan depuis 1987 à Dijon</p><p>Fromages affinés</p><p>Contact et horaires</p><p>Mentions légales</p></body></html>';
hooks.fetchPage = async () => ({
  status: 200, finalUrl: 'https://photo.test/', chain: [], ms: 30, ttfb: 10, size: 400, contentType: 'text/html', server: '', buf: Buffer.from('x'), body: page,
});
const hacked = '<html><head><title>X</title></head><body><h1>Hacked by Evil Crew</h1></body></html>';

test('alerte critique visuelle : le texte part d\'abord, puis la capture de la page en photo', async () => {
  const w = await dbm.createWatch({ name: 'Photo', url: 'https://photo.test/', interval: 5, config: noNet });
  await runCheck(w.id); // référence
  sent.length = 0;
  calls = 0;
  page = hacked;
  const r = await runCheck(w.id);
  assert.ok(r.alerts.some((a) => a.type === 'forbidden' && a.severity === 'critical'));
  await r.photo;
  assert.deepEqual(sent.map((s) => s.kind), ['sendMessage', 'sendPhoto'], 'message puis photo');
  assert.equal(sent[1].multipart, true);
  assert.match(sent[1].body, /name="chat_id"\r\n\r\n42/);
  assert.match(sent[1].body, /filename="capture\.jpg"/);
  assert.match(sent[1].body, /Photo/, 'légende avec le nom du site');
  assert.equal(calls, 1);
  assert.equal((await dbm.listScreenshots(w.id))[0].kind, 'alert', 'la capture est aussi conservée dans l\'historique');
});

test('pas de photo : site en panne, alerte non visuelle, option coupée, captures désactivées pour le site', async () => {
  const run = async (cfg, mutate) => {
    page = '<html><head><title>Site</title></head><body><h1>Bienvenue</h1><p>Artisan depuis 1987 à Dijon</p><p>Fromages affinés</p><p>Contact et horaires</p><p>Mentions légales</p></body></html>';
    const w = await dbm.createWatch({ name: 'NoPhoto' + Math.random(), url: 'https://photo.test/', interval: 5, config: { ...noNet, ...cfg } });
    await runCheck(w.id);
    sent.length = 0;
    await mutate();
    const r = await runCheck(w.id);
    await r.photo;
    return { r, kinds: sent.map((s) => s.kind) };
  };

  // 1. Option Telegram désactivée
  await dbm.saveSettings({ telegram: { sendScreenshot: false } });
  let o = await run({}, () => { page = hacked; });
  assert.ok(o.r.alerts.some((a) => a.type === 'forbidden'));
  assert.deepEqual(o.kinds, ['sendMessage']);
  await dbm.saveSettings({ telegram: { sendScreenshot: true } });

  // 2. Capture désactivée sur ce site
  o = await run({ screenshot: { enabled: false } }, () => { page = hacked; });
  assert.deepEqual(o.kinds, ['sendMessage']);

  // 3. Alerte critique mais non visuelle (DNS/registre : la page ne change pas)
  const realDns = hooks.lookupDns;
  let ns = ['ns1.a.test', 'ns2.a.test'];
  hooks.lookupDns = async () => ({ a: ['203.0.113.1'], aaaa: [], cname: [], ns, mx: [], spf: '', dmarc: '', caa: [], zone: 'photo.test', resolvers: {} });
  o = await run({ checks: { dns: true, tls: false, rdap: false } }, () => { ns = ['ns1.evil.test']; });
  assert.ok(o.r.alerts.some((a) => a.type === 'dns_ns' && a.severity === 'critical'));
  assert.deepEqual(o.kinds, ['sendMessage'], 'un changement de NS ne justifie pas de capturer la page');
  hooks.lookupDns = realDns;

  // 4. Site en panne : la capture échouerait de toute façon
  const realFetch = hooks.fetchPage;
  o = await run({ failThreshold: 1 }, () => { hooks.fetchPage = async () => { throw Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } }); }; });
  hooks.fetchPage = realFetch;
  assert.ok(o.r.alerts.some((a) => a.type === 'down'));
  assert.deepEqual(o.kinds, ['sendMessage']);
});

test('domaine seul : aucune capture', async () => {
  const w = await dbm.createWatch({ name: 'Dom', url: 'https://dom.test/', interval: 5, config: { mode: 'domain', checks: { dns: false, rdap: false } } });
  calls = 0;
  await runCheck(w.id);
  assert.equal(calls, 0);
});

test.after(() => {
  telegram.close();
  dbm.db.close();
});
