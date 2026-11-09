import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'suricate-dom-'));

const dbm = await import('../src/db.js');
const { runCheck, hooks } = await import('../src/checker.js');
const { fmtDuration } = await import('../src/util.js');
const { DAY_MS } = dbm;

const types = (r) => r.alerts.map((a) => a.type);
const sev = (r, type) => r.alerts.find((a) => a.type === type)?.severity;

// ───────────── Disponibilité : calcul en temps ─────────────

test('uptime : calculé sur la durée des pannes, pas sur le nombre de contrôles', async () => {
  const now = Date.UTC(2026, 5, 15, 12, 0, 0);
  const w = await dbm.createWatch({ name: 'uptime', url: 'http://a.test/', interval: 5 });
  await dbm.db.run('UPDATE watches SET created_at = ? WHERE id = ?', [now - 10 * DAY_MS, w.id]);
  const watch = await dbm.getWatch(w.id);

  const o1 = await dbm.openOutage(w.id, now - 2 * DAY_MS, 'HTTP 503', 503);
  await dbm.closeOutage(o1, now - 2 * DAY_MS + 3600e3); // 1 h il y a 2 jours
  await dbm.openOutage(w.id, now - 30 * 60e3, 'Délai dépassé', null); // panne en cours depuis 30 min

  const s = await dbm.uptimeSummary(watch, now);
  assert.ok(Math.abs(s['24h'].uptime - 100 * (1 - 30 / 1440)) < 1e-9, `24h = ${s['24h'].uptime}`);
  assert.equal(s['24h'].outages, 1);
  assert.ok(Math.abs(s['7d'].uptime - 100 * (1 - 90 / (7 * 1440))) < 1e-9, `7j = ${s['7d'].uptime}`);
  assert.equal(s['7d'].outages, 2);
  // Surveillé depuis 10 jours seulement : 30 j et 90 j sont bornés au début de la surveillance.
  assert.ok(Math.abs(s['90d'].uptime - 100 * (1 - 90 / (10 * 1440))) < 1e-9, `90j = ${s['90d'].uptime}`);

  // Barres journalières (UTC) : la panne d'il y a 2 jours n'affecte que ce jour-là.
  const bars = await dbm.uptimeBars(watch, 0, now);
  assert.equal(bars.length, 90);
  assert.equal(bars.at(-1).outages, 1); // aujourd'hui : panne en cours
  assert.ok(Math.abs(bars.at(-3).uptime - 100 * (1 - 1 / 24)) < 1e-9, `J-2 = ${bars.at(-3).uptime}`);
  assert.equal(bars.at(-2).uptime, 100); // hier : aucune panne
  assert.equal(bars[0].uptime, null); // avant la création du site : pas de donnée
  assert.equal((await dbm.uptimeBetween({ ...watch, createdAt: now - 10e3 }, now - DAY_MS, now, now)).uptime, null, 'moins d\'1 min de recul');

  const list = await dbm.outageList(w.id, 10, now);
  assert.equal(list[0].ongoing, true);
  assert.equal(list[0].duration, 30 * 60e3);
  assert.equal(list[1].duration, 3600e3);
});

test('fmtDuration', () => {
  assert.equal(fmtDuration(45e3), '45 s');
  assert.equal(fmtDuration(12 * 60e3), '12 min');
  assert.equal(fmtDuration(3 * 3600e3 + 5 * 60e3), '3 h 05');
  assert.equal(fmtDuration(2 * DAY_MS + 4 * 3600e3), '2 j 4 h');
});

// ───────────── Cycle de vie d'une panne ─────────────

const okPage = (status = 200) => ({
  status, finalUrl: 'https://shop.test/', chain: [], ms: 40, ttfb: 20, size: 500, contentType: 'text/html', server: 'nginx',
  buf: Buffer.from('x'), body: '<html><head><title>Shop</title></head><body><h1>Boutique</h1><p>Bienvenue</p></body></html>',
});
let next = () => okPage();
hooks.fetchPage = async () => {
  const r = next();
  if (r instanceof Error) throw r;
  return r;
};
const noNet = { checks: { dns: false, tls: false, rdap: false } };

test('panne : confirmée après 2 échecs, datée du 1er échec, fin avec durée', async () => {
  const w = await dbm.createWatch({ name: 'Shop', url: 'https://shop.test/', interval: 5, config: noNet });
  assert.deepEqual(types(await runCheck(w.id)), []);

  next = () => Object.assign(new Error('x'), { cause: { code: 'ECONNREFUSED' } });
  const t1 = Date.now();
  assert.deepEqual(types(await runCheck(w.id)), [], '1er échec : pas encore de panne');
  assert.equal((await dbm.outageList(w.id)).length, 0);
  const r2 = await runCheck(w.id);
  assert.deepEqual(types(r2), ['down']);
  const [o] = await dbm.outageList(w.id);
  assert.ok(o.ongoing && o.start >= t1 && o.start <= Date.now());
  assert.match(o.reason, /refusée/);

  await new Promise((r) => setTimeout(r, 30));
  next = () => okPage();
  const r3 = await runCheck(w.id);
  assert.deepEqual(types(r3), ['recovery'], 'un seul message de rétablissement, avec la durée');
  assert.match(r3.alerts[0].detail, /Indisponible pendant \d+ s/);
  assert.equal((await dbm.outageList(w.id))[0].ongoing, false);
  assert.equal((await dbm.getWatch(w.id)).state.outageId, null);
});

test('erreur HTTP 503 = panne ; 403 = site joignable, donc pas une panne', async () => {
  const w = await dbm.createWatch({ name: 'Http', url: 'https://http.test/', interval: 5, config: noNet });
  await runCheck(w.id);
  next = () => okPage(503);
  assert.deepEqual(types(await runCheck(w.id)), []);
  const r = await runCheck(w.id);
  assert.deepEqual(types(r), ['http']);
  assert.equal(sev(r, 'http'), 'critical');
  assert.equal((await dbm.outageList(w.id)).length, 1);
  next = () => okPage();
  assert.deepEqual(types(await runCheck(w.id)), ['recovery']);

  next = () => okPage(403);
  const r403 = await runCheck(w.id);
  assert.equal(sev(r403, 'http'), 'warning');
  assert.equal((await dbm.outageList(w.id)).length, 1, 'aucune nouvelle panne');
  next = () => okPage();
  await runCheck(w.id);
});

test('stats journalières : agrégées à chaque contrôle', async () => {
  const w = await dbm.createWatch({ name: 'Stats', url: 'https://stats.test/', interval: 5, config: noNet });
  next = () => okPage();
  await runCheck(w.id);
  await runCheck(w.id);
  const row = await dbm.db.get('SELECT * FROM daily_stats WHERE watch_id = ?', [w.id]);
  assert.equal(row.n, 2);
  assert.equal(row.ok, 2);
  assert.equal(row.min_ms, 40);
  assert.equal((await dbm.responseStats(w.id, 30)).avg, 40);
  assert.equal((await dbm.responseStats(w.id, 1)).avg, 40);
  assert.equal((await dbm.responseSeries(w.id, '24h')).length, 2);
  assert.equal((await dbm.responseSeries(w.id, '7d')).length, 1, 'regroupé par heure');
  assert.equal((await dbm.responseSeries(w.id, '30d')).length, 1, 'regroupé par jour');
});

// ───────────── Détournement de DNS ─────────────

const NS = ['ns1.registrar.test', 'ns2.registrar.test'];
const baseDns = () => ({
  a: ['203.0.113.10'], aaaa: [], cname: [], ns: [...NS], mx: ['mx1.mail.test'], zone: 'hijack.test',
  spf: 'v=spf1 include:_spf.mail.test ~all', dmarc: 'v=DMARC1; p=reject', caa: ['issue letsencrypt.org'],
  resolvers: { Cloudflare: [...NS], Google: [...NS], Quad9: [...NS] },
});
let dns = baseDns();
hooks.lookupDns = async () => structuredClone(dns);

test('DNS : détection de détournement (NS, MX, SPF, CAA, IP)', async () => {
  const w = await dbm.createWatch({ name: 'Domaine', url: 'https://hijack.test', interval: 5, config: { mode: 'domain', checks: { rdap: false } } });
  assert.deepEqual(types(await runCheck(w.id)), [], 'référence');
  assert.deepEqual(types(await runCheck(w.id)), [], 'stable');
  assert.equal((await dbm.getWatch(w.id)).state.baseline, true);

  dns = { ...baseDns(), ns: ['ns1.evil.test', 'ns2.evil.test'], mx: ['mail.evil.test'], spf: 'v=spf1 +all', caa: ['issue evilca.test'], resolvers: { Cloudflare: NS, Google: NS, Quad9: NS } };
  const r = await runCheck(w.id);
  for (const t of ['dns_ns', 'dns_mx', 'dns_spf', 'dns_caa']) assert.ok(types(r).includes(t), `manque ${t} dans ${types(r)}`);
  assert.equal(sev(r, 'dns_ns'), 'critical');
  assert.match(r.alerts.find((a) => a.type === 'dns_ns').detail, /ns1\.evil\.test/);
  assert.ok(types(r).includes('dns_inconsistent'), 'résolveurs publics encore sur les anciens NS');

  // Les résolveurs convergent : l'incident est levé (rétabli), pas de nouvelle alerte de changement.
  dns = { ...dns, resolvers: { Cloudflare: dns.ns, Google: dns.ns, Quad9: dns.ns } };
  const r2 = await runCheck(w.id);
  assert.deepEqual(types(r2), ['recovery']);

  // Changement d'hébergeur complet : plage IP jamais vue.
  dns = { ...dns, a: ['198.51.100.7'] };
  assert.ok(types(await runCheck(w.id)).includes('dns_ip'));
  // Rotation partielle (CDN) : une plage déjà vue reste présente → silence.
  dns = { ...dns, a: ['198.51.100.9', '203.0.113.10'] };
  assert.deepEqual(types(await runCheck(w.id)), []);
});

test('DNS : une réponse vide ou partielle ne produit pas de fausse alerte', async () => {
  dns = baseDns();
  const w = await dbm.createWatch({ name: 'Flaky', url: 'https://flaky.test', interval: 5, config: { mode: 'domain', checks: { rdap: false } } });
  await runCheck(w.id);
  dns = { ...baseDns(), mx: [], spf: '', caa: [], resolvers: {} }; // requêtes TXT/MX/CAA en échec passager
  assert.deepEqual(types(await runCheck(w.id)), []);
  assert.deepEqual((await dbm.getWatch(w.id)).state.dns.mx, ['mx1.mail.test'], 'dernière valeur connue conservée');
  assert.equal((await dbm.getWatch(w.id)).state.dns.spf, baseDns().spf);
});

// ───────────── Transfert de domaine (registre) ─────────────

const baseRdap = () => ({
  registrar: 'Gandi SAS', registered: Date.UTC(2015, 0, 1), expires: Date.now() + 400 * DAY_MS, transferred: 0, changed: Date.UTC(2026, 0, 1),
  locked: true, status: ['client transfer prohibited', 'client update prohibited'], nameservers: [...NS], dnssec: true,
});
let rdap = baseRdap();
hooks.rdapLookup = async () => structuredClone(rdap);
const dueNow = async (id) => {
  const w = await dbm.getWatch(id);
  await dbm.updateWatch(id, { state: { ...w.state, rdap: { ...w.state.rdap, checkedAt: 0 } } });
};

test('registre : registrar, serveurs de noms, DNSSEC, verrou, statut de transfert', async () => {
  dns = baseDns();
  const w = await dbm.createWatch({ name: 'Registre', url: 'https://registre.test', interval: 5, config: { mode: 'domain' } });
  assert.deepEqual(types(await runCheck(w.id)), [], 'référence');
  assert.equal((await dbm.getWatch(w.id)).state.rdap.registrar, 'Gandi SAS');

  // Verrou retiré + délégation changée + DNSSEC coupé + transfert demandé : le scénario d'un vol de domaine.
  rdap = { ...baseRdap(), locked: false, status: ['pending transfer'], nameservers: ['ns1.evil.test', 'ns2.evil.test'], dnssec: false, changed: Date.now() };
  await dueNow(w.id);
  const r = await runCheck(w.id);
  for (const t of ['rdap_unlocked', 'rdap_ns', 'rdap_dnssec', 'rdap_changed', 'rdap_status']) assert.ok(types(r).includes(t), `manque ${t} dans ${types(r)}`);
  assert.equal(sev(r, 'rdap_ns'), 'critical');
  assert.equal(sev(r, 'rdap_dnssec'), 'critical');
  assert.equal(sev(r, 'rdap_status'), 'critical');
  assert.equal(sev(r, 'rdap_changed'), 'info');
  assert.match(r.alerts.find((a) => a.type === 'rdap_status').title, /pending transfer/);

  // Le transfert aboutit : nouveau registrar.
  rdap = { ...rdap, registrar: 'Registrar Pirate Ltd', status: ['ok'], transferred: Date.now() };
  await dueNow(w.id);
  const r2 = await runCheck(w.id);
  assert.ok(types(r2).includes('rdap_registrar'));
  assert.equal(sev(r2, 'rdap_registrar'), 'critical');
  assert.ok(types(r2).includes('recovery'), 'le statut « pending transfer » est levé');
});

test('registre : échéance proche = incident ; transfert daté sans changement de registrar', async () => {
  dns = baseDns();
  rdap = { ...baseRdap(), expires: Date.now() + 5 * DAY_MS };
  const w = await dbm.createWatch({ name: 'Echeance', url: 'https://echeance.test', interval: 5, config: { mode: 'domain' } });
  const r = await runCheck(w.id);
  assert.equal(sev(r, 'rdap_expiring'), 'critical', 'moins de 7 jours');
  rdap = { ...rdap, transferred: Date.now() };
  await dueNow(w.id);
  assert.ok(types(await runCheck(w.id)).includes('rdap_transfer'));
});

test('registre : l\'échéance ré-alerte en passant sous 7 jours, pas à chaque jour de moins', async () => {
  dns = baseDns();
  rdap = { ...baseRdap(), expires: Date.now() + 20 * DAY_MS };
  const w = await dbm.createWatch({ name: 'Rappel', url: 'https://rappel.test', interval: 5, config: { mode: 'domain' } });
  assert.equal(sev(await runCheck(w.id), 'rdap_expiring'), 'warning', 'moins de 30 jours');

  rdap = { ...rdap, expires: Date.now() + 12 * DAY_MS };
  await dueNow(w.id);
  assert.deepEqual(types(await runCheck(w.id)), [], 'même palier : pas une nouvelle alerte');

  rdap = { ...rdap, expires: Date.now() + 5 * DAY_MS };
  await dueNow(w.id);
  const r = await runCheck(w.id);
  assert.equal(sev(r, 'rdap_expiring'), 'critical', 'moins de 7 jours : on ré-alerte');
  assert.equal((await dbm.getWatch(w.id)).state.incidents.rdap_expiring.severity, 'critical');
});

test('mode domaine : aucune requête HTTP, aucune panne, contrôle toujours « ok »', async () => {
  let fetched = 0;
  const orig = hooks.fetchPage;
  hooks.fetchPage = async () => { fetched++; return okPage(); };
  dns = baseDns();
  const w = await dbm.createWatch({ name: 'SansSite', url: 'https://sanssite.test', interval: 5, config: { mode: 'domain', checks: { rdap: false } } });
  await runCheck(w.id);
  assert.equal(fetched, 0);
  assert.equal((await dbm.outageList(w.id)).length, 0);
  assert.equal((await dbm.db.get('SELECT ok FROM checks WHERE watch_id = ?', [w.id])).ok, 1);
  hooks.fetchPage = orig;
});

test.after(() => dbm.db.close());
