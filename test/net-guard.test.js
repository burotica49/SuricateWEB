// Garde réseau (src/net-guard.js) : VigieWeb ne doit pas servir à atteindre le réseau interne de son serveur.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'vigie-guard-'));
// Chrome réel : détecté normalement ; les cas qui en ont besoin sont ignorés sans navigateur.

const { createNetGuard, isBlockedAddress, netGuardFromEnv, NetGuardError } = await import('../src/net-guard.js');
const { configureExtensions, resetExtensions } = await import('../src/extensions.js');
const checker = await import('../src/checker.js');
const dbm = await import('../src/db.js');
const shots = await import('../src/screenshot.js');
const { createApp } = await import('../src/app.js');
const { isRunning } = await import('../src/scheduler.js');

test.afterEach(() => resetExtensions());

// ───────────── Quelles adresses sont interdites ─────────────

test('adresses IPv4 : privées, boucle locale, lien local (métadonnées cloud), CGNAT, multicast, réservées → interdites ; publiques → permises', () => {
  for (const ip of ['127.0.0.1', '127.255.255.254', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '169.254.0.1',
    '100.64.0.1', '100.127.255.255', '0.0.0.0', '0.1.2.3', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255', '192.0.2.1', '198.18.0.1', '198.51.100.7', '203.0.113.9']) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '169.253.0.1', '11.0.0.1', '192.167.0.1', '192.169.0.1']) {
    assert.equal(isBlockedAddress(ip), false, ip);
  }
});

test('adresses IPv6 : boucle locale, locales (ULA, lien local), multicast, documentation, 6to4, NAT64 → interdites ; IPv4 « mappées » jugées comme l\'IPv4', () => {
  for (const ip of ['::', '::1', 'fe80::1', 'fe80::1%eth0', 'fd00::1', 'fc00::abcd', 'fec0::1', 'ff02::1', '2001:db8::1', '2002:7f00:1::', '64:ff9b::7f00:1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::FFFF:10.0.0.1', '0:0:0:0:0:ffff:a00:1', '::ffff:169.254.169.254', '[::1]']) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  for (const ip of ['2606:4700:4700::1111', '2a00:1450:4007:80f::200e', '::ffff:8.8.8.8', '::ffff:808:808']) {
    assert.equal(isBlockedAddress(ip), false, ip);
  }
});

test('ce qui n\'est pas une adresse IP est interdit : dans le doute, on refuse', () => {
  for (const x of ['', 'localhost', 'exemple.fr', '999.1.1.1', '1.2.3', null, undefined, '0x7f000001', '2130706433', '127.1']) assert.equal(isBlockedAddress(x), true, String(x));
});

// ───────────── Contrôle d'une adresse (sans réseau) ─────────────

const refused = (guard, url) => { try { guard.checkUrl(url); return null; } catch (e) { assert.ok(e instanceof NetGuardError); assert.equal(e.code, 'ESSRF'); return e.message; } };

test('checkUrl : schéma, port, adresse IP écrite telle quelle, localhost', () => {
  const g = createNetGuard();
  assert.equal(refused(g, 'https://exemple.fr/'), null);
  assert.equal(refused(g, 'http://exemple.fr:8080/x'), null);
  assert.equal(refused(g, 'http://8.8.8.8/'), null);
  assert.match(refused(g, 'ftp://exemple.fr/'), /http/);
  assert.match(refused(g, 'file:///etc/passwd'), /http/);
  assert.match(refused(g, 'gopher://exemple.fr/'), /http/);
  assert.match(refused(g, 'http://exemple.fr:22/'), /Port 22 non autorisé/);
  assert.match(refused(g, 'https://exemple.fr:6379/'), /Port 6379/);
  assert.match(refused(g, 'http://127.0.0.1/'), /réseau privé/);
  assert.match(refused(g, 'http://127.0.0.1:8080/'), /réseau privé/);
  assert.match(refused(g, 'http://169.254.169.254/latest/meta-data/'), /réseau privé/);
  assert.match(refused(g, 'http://[::1]/'), /réseau privé/);
  assert.match(refused(g, 'http://[::ffff:127.0.0.1]/'), /réseau privé/);
  assert.match(refused(g, 'http://[fd00::1]/'), /réseau privé/);
  assert.match(refused(g, 'http://localhost/'), /réseau privé/);
  assert.match(refused(g, 'http://api.localhost/'), /réseau privé/);
  assert.match(refused(g, 'http://LOCALHOST:8080/'), /réseau privé/);
  // les écritures détournées d'une même adresse (décimale, octale, hexadécimale, courte) sont normalisées par URL
  for (const u of ['http://2130706433/', 'http://0x7f000001/', 'http://017700000001/', 'http://127.1/', 'http://0/']) assert.match(refused(g, u), /réseau privé/, u);
  assert.match(refused(g, 'pas une adresse'), /invalide/);
});

test('ports : liste par défaut, liste personnalisée, « * »', () => {
  assert.equal(refused(createNetGuard(), 'http://exemple.fr:8443/'), null);
  assert.match(refused(createNetGuard({ allowedPorts: [443] }), 'http://exemple.fr/'), /Port 80/);
  assert.equal(refused(createNetGuard({ allowedPorts: '*' }), 'http://exemple.fr:31337/'), null);
  assert.equal(refused(createNetGuard({ allowedPorts: ['*'] }), 'http://exemple.fr:31337/'), null);
  assert.deepEqual(createNetGuard().allowedPorts, [80, 443, 8080, 8443]);
});

test('exceptions explicites : un nom, une adresse ou une plage peut être surveillé malgré tout', () => {
  const g = createNetGuard({ allowHosts: ['intranet.exemple', '10.0.0.5', '10.1.0.0/16', 'fd00::/8', '127.0.0.1'] });
  assert.equal(refused(g, 'https://intranet.exemple/'), null);
  assert.equal(refused(g, 'https://INTRANET.exemple/'), null, 'sans tenir compte de la casse');
  assert.equal(refused(g, 'http://10.0.0.5/'), null);
  assert.equal(refused(g, 'http://10.1.200.3/'), null);
  assert.equal(refused(g, 'http://[fd00::1]/'), null);
  assert.equal(refused(g, 'http://127.0.0.1/'), null);
  assert.match(refused(g, 'http://10.0.0.6/'), /réseau privé/, 'seule l\'adresse nommée est permise');
  assert.match(refused(g, 'http://10.2.0.1/'), /réseau privé/);
  assert.match(refused(g, 'http://169.254.169.254/'), /réseau privé/);
  assert.match(refused(g, 'http://localhost/'), /réseau privé/, 'localhost n\'est pas 127.0.0.1 : exception à donner séparément');
  assert.match(refused(g, 'http://intranet.exemple:22/'), /Port 22/, 'une exception de machine ne lève pas la règle des ports');
});

test('garde inerte : ne refuse rien et se comporte comme fetch()', () => {
  const g = createNetGuard({ enabled: false });
  assert.equal(g.enabled, false);
  assert.equal(refused(g, 'http://127.0.0.1:22/'), null);
  assert.equal(g.lookup, undefined);
  assert.equal(typeof g.fetch, 'function');
});

test('environnement : VIGIE_NET_GUARD active la garde ; ports et exceptions en listes', () => {
  assert.equal(netGuardFromEnv({}), null);
  assert.equal(netGuardFromEnv({ VIGIE_NET_GUARD: '0' }), null);
  const g = netGuardFromEnv({ VIGIE_NET_GUARD: '1' });
  assert.equal(g.enabled, true);
  assert.deepEqual(g.allowedPorts, [80, 443, 8080, 8443]);
  const g2 = netGuardFromEnv({ VIGIE_NET_GUARD: 'yes', VIGIE_NET_ALLOW_PORTS: '443, 9000', VIGIE_NET_ALLOW_HOSTS: 'Intranet.Exemple, 10.0.0.5 ,10.1.0.0/16' });
  assert.deepEqual(g2.allowedPorts, [443, 9000]);
  assert.equal(refused(g2, 'https://intranet.exemple/'), null);
  assert.equal(refused(g2, 'http://10.1.2.3:443/'), null);
  assert.equal(netGuardFromEnv({ VIGIE_NET_GUARD: '1', VIGIE_NET_ALLOW_PORTS: '*' }).allowedPorts, '*');
});

// ───────────── Résolution DNS contrôlée au moment de la connexion ─────────────

const look = (guard, host, options = {}) => new Promise((resolve) => guard.lookup(host, options, (err, address, family) => resolve({ err, address, family })));

test('lookup : un nom qui pointe vers une adresse interne est refusé AU MOMENT de la connexion (anti DNS rebinding)', async () => {
  const g = createNetGuard();
  const r = await look(g, 'localhost');
  assert.equal(r.err.code, 'ESSRF');
  assert.match(r.err.message, /pointe vers un réseau privé/);
  const all = await look(g, 'localhost', { all: true });
  assert.equal(all.err.code, 'ESSRF', 'même avec toutes les adresses demandées (le cas de la connexion « happy eyeballs »)');
});

test('lookup : un nom exempté passe ; un nom introuvable garde son erreur DNS', async () => {
  const g = createNetGuard({ allowHosts: ['localhost'] });
  const r = await look(g, 'localhost');
  assert.equal(r.err, null);
  assert.ok(['127.0.0.1', '::1'].includes(r.address));
  const nf = await look(createNetGuard(), 'domaine-inexistant-vigie.invalid');
  assert.equal(nf.err.code, 'ENOTFOUND');
});

test('allows : résout le nom (pour Chrome) ; les noms introuvables sont laissés à Chrome', async () => {
  const g = createNetGuard();
  assert.equal(await g.allows('http://127.0.0.1/'), false);
  assert.equal(await g.allows('http://localhost/'), false);
  assert.equal(await g.allows('http://8.8.8.8/'), true);
  assert.equal(await g.allows('ftp://8.8.8.8/'), false);
  assert.equal(await g.allows('http://8.8.8.8:22/'), false);
  assert.equal(await g.allows('http://domaine-inexistant-vigie.invalid/'), true);
  assert.equal(await createNetGuard({ allowHosts: ['localhost'] }).allows('http://localhost/'), true);
});

// ───────────── Le client HTTP de la garde : même résultat que fetch() ─────────────

const PLAIN = 'Bonjour é à ü — ' + 'x'.repeat(5000);
let hits = 0;
const origin = http.createServer((req, res) => {
  hits++;
  const path = req.url;
  if (path === '/plain') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', server: 'Faux/1.0', 'x-powered-by': 'Test' }); return res.end(PLAIN); }
  if (path === '/gzip') { res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' }); return res.end(zlib.gzipSync(PLAIN)); }
  if (path === '/br') { res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'br' }); return res.end(zlib.brotliCompressSync(PLAIN)); }
  if (path === '/deflate') { res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'deflate' }); return res.end(zlib.deflateSync(PLAIN)); }
  if (path === '/redirect') { res.writeHead(302, { location: '/plain', 'content-length': '5' }); return res.end('corps'); }
  if (path === '/cookies') { res.writeHead(200, { 'set-cookie': ['a=1; Path=/', 'b=2; HttpOnly'], 'content-type': 'text/plain' }); return res.end('ok'); }
  if (path === '/nobody') { res.writeHead(204); return res.end(); }
  if (path === '/notfound') { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('absent'); }
  if (path === '/echo') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ua: req.headers['user-agent'], cookie: req.headers.cookie, accept: req.headers.accept, host: req.headers.host, ae: req.headers['accept-encoding'] })); }
  if (path === '/slow') { res.writeHead(200, { 'content-type': 'text/plain' }); res.write('début'); return; /* ne se termine jamais */ }
  if (path === '/big') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    const chunk = Buffer.alloc(65536, 97);
    const send = () => { while (res.write(chunk)) { /* continue tant que le tampon n'est pas plein */ } res.once('drain', send); };
    res.on('close', () => { /* le client a coupé */ });
    return send();
  }
  res.writeHead(500); res.end('?');
});
origin.on('connection', (s) => s.setNoDelay(true));
await new Promise((r) => origin.listen(0, '127.0.0.1', r));
const PORT = origin.address().port;
const at = (p) => `http://127.0.0.1:${PORT}${p}`;
const open = () => createNetGuard({ allowHosts: ['127.0.0.1'], allowedPorts: '*' });

test('client de la garde : adresse interdite refusée AVANT toute connexion', async () => {
  const before = hits;
  const g = createNetGuard({ allowedPorts: '*' });
  await assert.rejects(g.fetch(at('/plain')), (e) => e.code === 'ESSRF' && /réseau privé/.test(e.message));
  await assert.rejects(g.fetch(`http://localhost:${PORT}/plain`), (e) => e.code === 'ESSRF');
  await assert.rejects(g.fetch(`http://[::1]:${PORT}/plain`), (e) => e.code === 'ESSRF');
  await assert.rejects(g.fetch('file:///etc/passwd'), (e) => e.code === 'ESSRF');
  assert.equal(hits, before, 'le serveur n\'a reçu AUCUNE requête');
});

test('client de la garde : un nom qui pointe vers l\'interne est refusé à la connexion, sans que le serveur voie la requête', async () => {
  const before = hits;
  // « localhost » n'est pas exempté mais passe le contrôle d'adresse (ce n'est ni une IP ni « localhost » exact : on l'écrit autrement)
  const g = createNetGuard({ allowedPorts: '*', allowHosts: ['127.0.0.1'] });
  await assert.rejects(g.fetch(`http://localhost.:${PORT}/plain`), (e) => e.code === 'ESSRF' || e.code === 'ENOTFOUND', 'nom pointé vers la boucle locale');
  assert.equal(hits, before);
});

for (const path of ['/plain', '/gzip', '/br', '/deflate', '/notfound', '/cookies', '/redirect', '/nobody']) {
  test(`client de la garde : ${path} → même statut, mêmes en-têtes utiles et même corps que fetch()`, async () => {
    const mine = await open().fetch(at(path), { redirect: 'manual', headers: { accept: 'text/html' } });
    const ref = await fetch(at(path), { redirect: 'manual', headers: { accept: 'text/html' } });
    assert.equal(mine.status, ref.status);
    for (const h of ['content-type', 'location', 'server', 'x-powered-by']) assert.equal(mine.headers.get(h), ref.headers.get(h), h);
    assert.deepEqual(mine.headers.getSetCookie(), ref.headers.getSetCookie());
    // Le corps d'une redirection est volontairement ignoré (inutile, et parfois énorme) ; pour le reste, il est identique.
    if (mine.status < 300 || mine.status >= 400) assert.equal(await mine.text(), await ref.text(), 'corps décodé identique');
    assert.equal(mine.headers.get('content-encoding'), null, 'compression déjà levée');
  });
}

test('client de la garde : redirection non suivie (à l\'appelant de la juger), cookies multiples', async () => {
  const r = await open().fetch(at('/redirect'));
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/plain');
  assert.equal(r.body, null, 'le corps d\'une redirection est ignoré');
  const c = await open().fetch(at('/cookies'));
  assert.deepEqual(c.headers.getSetCookie(), ['a=1; Path=/', 'b=2; HttpOnly']);
});

test('client de la garde : en-têtes de la requête transmis tels quels ; la compression est annoncée', async () => {
  const r = await (await open().fetch(at('/echo'), { headers: { 'User-Agent': 'AgentTest/9', cookie: 'k=v', Accept: 'text/html' } })).json();
  assert.deepEqual([r.ua, r.cookie, r.accept, r.host], ['AgentTest/9', 'k=v', 'text/html', `127.0.0.1:${PORT}`]);
  assert.match(r.ae, /gzip/);
});

test('client de la garde : délai (signal) → AbortError ; corps coupé quand le lecteur renonce ; connexion refusée → ECONNREFUSED', async () => {
  const slow = await open().fetch(at('/slow'), { signal: AbortSignal.timeout(300) });
  assert.equal(slow.status, 200);
  await assert.rejects(slow.text(), (e) => e.name === 'TimeoutError', 'pendant la lecture du corps : la même erreur que fetch()');
  await assert.rejects(open().fetch(at('/slow'), { signal: AbortSignal.timeout(1) }).then((r) => r.text()), (e) => e.name === 'TimeoutError');
  const ctrl = new AbortController();
  ctrl.abort();
  await assert.rejects(open().fetch(at('/plain'), { signal: ctrl.signal }), (e) => e.name === 'AbortError', 'signal déjà annulé');

  const big = await open().fetch(at('/big'));
  const reader = big.body.getReader();
  let got = 0;
  while (got < 300000) got += (await reader.read()).value.length;
  await reader.cancel();
  assert.ok(got >= 300000);

  const free = http.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => free.once('listening', r));
  const closedPort = free.address().port;
  await new Promise((r) => free.close(r));
  await assert.rejects(open().fetch(`http://127.0.0.1:${closedPort}/`), (e) => e.code === 'ECONNREFUSED');
});

// ───────────── Les contrôles passent par la garde ─────────────

test('fetchPage : garde active → adresse interne refusée, message clair ; exemptée → page lue comme sans garde', async () => {
  const cfg = dbm.normalizeConfig({ timeoutS: 5 });
  const settings = await dbm.settingsFor(1);
  configureExtensions({ netGuard: createNetGuard({ allowedPorts: '*' }) });
  const before = hits;
  await assert.rejects(checker.fetchPage(at('/plain'), cfg, settings), (e) => {
    const d = checker.describeError(e);
    assert.equal(d.code, 'ESSRF');
    assert.match(d.message, /Adresse non autorisée/);
    return true;
  });
  assert.equal(hits, before);

  configureExtensions({ netGuard: open() });
  const guarded = await checker.fetchPage(at('/gzip'), cfg, settings);
  resetExtensions();
  const plain = await checker.fetchPage(at('/gzip'), cfg, settings);
  assert.deepEqual([guarded.status, guarded.size > 0, guarded.body], [plain.status, true, plain.body]);
  assert.equal(guarded.server, plain.server);
});

test('fetchPage : une redirection vers une adresse interne est refusée à son tour', async () => {
  const redirector = http.createServer((q, r) => { r.writeHead(302, { location: `http://127.0.0.1:${PORT}/plain` }); r.end(); });
  await new Promise((r) => redirector.listen(0, '127.0.0.1', r));
  // Le point de départ est permis (exception), la destination ne l'est pas : une exception de machine n'ouvre que cette machine.
  const startPort = redirector.address().port;
  configureExtensions({ netGuard: createNetGuard({ allowedPorts: [startPort], allowHosts: ['localhost'] }) });
  // « localhost » exempté sert de départ ; la cible est 127.0.0.1 (non exempté, port non autorisé)
  const before = hits;
  await assert.rejects(checker.fetchPage(`http://localhost:${startPort}/`, dbm.normalizeConfig({ timeoutS: 5 }), await dbm.settingsFor(1)), (e) => e.code === 'ESSRF');
  assert.equal(hits, before, 'la destination interne n\'a jamais été contactée');
  redirector.close();
});

test('tlsInfo : adresse interne refusée sans connexion', async () => {
  configureExtensions({ netGuard: createNetGuard() });
  await assert.rejects(checker.tlsInfo('127.0.0.1', 443), (e) => e.code === 'ESSRF');
  await assert.rejects(checker.tlsInfo('10.0.0.1', 443), (e) => e.code === 'ESSRF');
  await assert.rejects(checker.tlsInfo('exemple.fr', 22), (e) => e.code === 'ESSRF' && /Port 22/.test(e.message));
  await assert.rejects(checker.tlsInfo('::1', 443), (e) => e.code === 'ESSRF');
});

test('contrôle complet : un site à adresse interne est déclaré en erreur « adresse non autorisée », rien n\'est contacté', async () => {
  configureExtensions({ netGuard: createNetGuard({ allowedPorts: '*' }) });
  const before = hits;
  const w = await dbm.createWatch({ name: 'Interne', url: at('/plain'), interval: 5, config: { checks: { dns: false, tls: false, rdap: false } } });
  const r = await checker.runCheck(w.id);
  assert.match(r.error, /Adresse non autorisée/);
  assert.equal(hits, before);
  assert.match((await dbm.getWatch(w.id)).lastError, /Adresse non autorisée/);
});

// ───────────── Saisie dans l'API ─────────────

const USERS = { alice: { user: { id: 1, name: 'alice' }, account: { id: 10 } } };
const fakeAuth = { authenticate: (req) => USERS[req.headers['x-user']] ?? null, register: ({ route }) => route('GET', '/api/auth', () => ({}), { public: true }) };

async function withApp(options, fn) {
  const app = createApp({ auth: fakeAuth, ...options });
  const base = `http://127.0.0.1:${await app.listen(0, '127.0.0.1')}`;
  const call = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'x-user': 'alice', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  try { await fn(call); } finally { await app.stop(); }
}

test('API : adresse interdite refusée dès la saisie (création, modification, test d\'adresse), avec la raison', async () => {
  await withApp({ netGuard: { enabled: true } }, async (call) => {
    for (const url of ['http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://localhost:8080/', 'http://[::1]/', 'http://exemple.fr:22/', 'http://10.0.0.5/']) {
      const r = await call('POST', '/api/watches', { url, name: 'X' });
      assert.equal(r.status, 400, url);
      assert.match(r.json.error, /non autorisé|http/, url);
      assert.equal((await call('POST', '/api/test-url', { url })).status, 400, `test-url ${url}`);
    }
    assert.equal((await dbm.listWatches(10)).length, 0, 'aucun site créé');
    // une modification d'adresse vers l'interne est refusée aussi
    const ok = await dbm.createWatch({ name: 'Légitime', url: 'http://exemple.invalid/', interval: 5, accountId: 10, config: { checks: { dns: false, tls: false, rdap: false } } });
    const r = await call('PUT', `/api/watches/${ok.id}`, { url: 'http://192.168.0.1/' });
    assert.equal(r.status, 400);
    assert.equal((await dbm.getWatch(ok.id)).url, 'http://exemple.invalid/');
  });
});

test('API : sans garde (installation personnelle), les adresses internes restent permises', async () => {
  await withApp({}, async (call) => {
    const r = await call('POST', '/api/watches', { url: `http://127.0.0.1:${PORT}/plain`, name: 'Local', config: { checks: { dns: false, tls: false, rdap: false }, screenshot: { enabled: false } } });
    assert.equal(r.status, 200);
    for (let i = 0; i < 200 && isRunning(r.json.id); i++) await new Promise((x) => setTimeout(x, 25));
  });
});

test('createApp : la garde vient de l\'option, de ses options, ou de l\'environnement', async () => {
  const { getExtensions } = await import('../src/extensions.js');
  const a = createApp({ auth: fakeAuth, netGuard: createNetGuard({ allowHosts: ['x.test'] }) });
  assert.equal(getExtensions().netGuard.enabled, true);
  resetExtensions();
  createApp({ auth: fakeAuth, netGuard: { enabled: true, allowedPorts: [443] } });
  assert.deepEqual(getExtensions().netGuard.allowedPorts, [443]);
  resetExtensions();
  createApp({ auth: fakeAuth, env: { VIGIE_NET_GUARD: '1' } });
  assert.equal(getExtensions().netGuard.enabled, true);
  resetExtensions();
  createApp({ auth: fakeAuth, env: {} });
  assert.equal(getExtensions().netGuard.enabled, false, 'par défaut : inerte');
  assert.throws(() => configureExtensions({ netGuard: {} }), /createNetGuard/);
  await a.stop();
});

// ───────────── Chrome ─────────────

const noChrome = !shots.chromePath() && 'Chrome/Chromium introuvable';

test('Chrome : adresse interne refusée avant même de lancer le navigateur', { skip: noChrome }, async () => {
  const g = createNetGuard({ allowedPorts: '*' });
  await assert.rejects(shots.capture(at('/plain'), { settleMs: 0, guard: g }), /réseau privé/);
  await assert.rejects(shots.capture('http://169.254.169.254/', { settleMs: 0, guard: g }), /réseau privé|Port|non autorisé/);
  await assert.rejects(shots.capture('file:///etc/passwd', { settleMs: 0, guard: g }), /http/);
});

test('Chrome : une page autorisée qui charge une ressource INTERNE ne la charge pas (la requête est interceptée)', { skip: noChrome }, async () => {
  let secretHits = 0;
  const secret = http.createServer((q, r) => { secretHits++; r.writeHead(200, { 'content-type': 'image/gif' }); r.end(Buffer.from('R0lGODlhAQABAAAAACw=', 'base64')); });
  await new Promise((r) => secret.listen(0, '127.0.0.1', r));
  const secretPort = secret.address().port;
  // La page vient de 127.0.0.1 (exemptée) ; l'image, de « localhost » (non exempté) : même machine, autre nom.
  const page = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(`<html><body><h1>Page</h1><img src="http://localhost:${secretPort}/secret.gif"><iframe src="http://localhost:${secretPort}/frame"></iframe></body></html>`); });
  await new Promise((r) => page.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${page.address().port}/`;
  const opts = { width: 600, height: 400, settleMs: 0, interact: false, hideBanners: false, timeoutMs: 15000 };
  try {
    const free = await shots.capture(url, opts); // sans garde : la ressource est chargée
    assert.ok(free.image.length > 100);
    assert.ok(secretHits >= 1, 'témoin : sans garde, Chrome atteint la ressource');
    secretHits = 0;
    const guarded = await shots.capture(url, { ...opts, guard: createNetGuard({ allowedPorts: '*', allowHosts: ['127.0.0.1'] }) });
    assert.ok(guarded.image.length > 100, 'la page autorisée est bien capturée');
    assert.equal(secretHits, 0, 'la ressource interne n\'a JAMAIS été demandée au serveur');
  } finally {
    secret.close();
    page.close();
  }
});

test.after(() => {
  origin.closeAllConnections();
  origin.close();
  dbm.db.close();
});
