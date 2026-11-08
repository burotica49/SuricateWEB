import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Rapport mensuel client : bornes du mois, calculs et mise en page.
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'vigie-report-'));

const dbm = await import('../src/db.js');
const { monthRange, siteReport, renderReport, statusData, renderStatusPage, fmtPct } = await import('../src/report.js');

const H = 3600e3;
const D = 86400e3;
// 2 novembre 2026, 10 h UTC : le mois entier précédent est octobre 2026.
const NOW = Date.parse('2026-11-02T10:00:00Z');
const OCT = Date.parse('2026-10-01T00:00:00Z');
const NOV = Date.parse('2026-11-01T00:00:00Z');

test('mois du rapport : par défaut le dernier mois entier, fuseau horaire pris en compte', () => {
  const r = monthRange(undefined, 0, NOW);
  assert.deepEqual([r.key, r.from, r.to, r.partial, r.days, r.prev, r.next], ['2026-10', OCT, NOV, false, 31, '2026-09', '2026-11']);
  assert.equal(r.label, 'octobre 2026');
  assert.equal(monthRange('', 0, NOW).key, '2026-10');

  const paris = monthRange('2026-10', 60, NOW); // +60 min : minuit local = 23 h UTC la veille
  assert.equal(paris.from, OCT - H);
  assert.equal(paris.to, NOV - H);
  assert.equal(monthRange('2026-10', 120, NOW).days, 31, 'octobre local');

  const current = monthRange('2026-11', 0, NOW);
  assert.deepEqual([current.partial, current.next, current.prev], [true, null, '2026-10'], 'mois en cours : pas de « suivant »');
  assert.equal(monthRange('2026-12', 0, NOW), null, 'le futur n’existe pas');
  assert.equal(monthRange('2026-13', 0, NOW), null);
  assert.equal(monthRange('octobre', 0, NOW), null);
  assert.equal(monthRange('1999-01', 0, NOW), null);
  assert.equal(monthRange('2026-02', 0, NOW).days, 28);
  assert.equal(monthRange(undefined, 0, Date.parse('2027-01-15T00:00:00Z')).key, '2026-12', 'janvier → décembre de l’année précédente');
  // 23 h 30 UTC le 31 octobre : il est déjà 00 h 30 le 1er novembre à Paris, donc le dernier mois entier y est octobre
  assert.equal(monthRange(undefined, 60, Date.parse('2026-10-31T23:30:00Z')).key, '2026-10');
  assert.equal(monthRange(undefined, 0, Date.parse('2026-10-31T23:30:00Z')).key, '2026-09', 'et septembre en UTC');
});

test('pourcentage : tronqué, jamais arrondi vers le haut', () => {
  assert.equal(fmtPct(100), '100 %');
  assert.equal(fmtPct(99.9996), '99,999 %');
  assert.equal(fmtPct(99.95), '99,950 %');
  assert.equal(fmtPct(97.456), '97,45 %');
  assert.equal(fmtPct(null), '—');
});

// ── Un site suivi depuis septembre, avec une panne en octobre ──
const w = await dbm.createWatch({ name: 'Cabinet <b>Martin</b>', url: 'https://www.cabinet-martin.example/', interval: 5, config: { checks: { dns: false, tls: false, rdap: false }, cms: { type: 'wordpress', token: 'a'.repeat(32) } } });
await dbm.db.run('UPDATE watches SET created_at = ? WHERE id = ?', [Date.parse('2026-09-01T00:00:00Z'), w.id]);
const o1 = await dbm.openOutage(w.id, Date.parse('2026-10-10T08:00:00Z'), 'Erreur HTTP 503', 503);
await dbm.closeOutage(o1, Date.parse('2026-10-10T10:00:00Z')); // 2 h
const o2 = await dbm.openOutage(w.id, Date.parse('2026-09-30T23:00:00Z'), 'Délai dépassé'); // à cheval sur septembre / octobre
await dbm.closeOutage(o2, Date.parse('2026-10-01T01:00:00Z')); // 1 h en octobre
await dbm.addMaintenance({ watchId: w.id, start: Date.parse('2026-10-20T01:00:00Z'), end: Date.parse('2026-10-20T03:00:00Z'), note: 'Mise à jour <script>x</script>' });
for (const [i, ms] of [200, 300, 400].entries()) await dbm.upsertDaily(w.id, OCT + i * D + H, true, ms);
const alert = async (ts, severity, type, title) => await dbm.db.run('INSERT INTO alerts(watch_id, ts, severity, type, title, detail, read) VALUES(?,?,?,?,?,?,1)', [w.id, ts, severity, type, title, 'DETAIL TECHNIQUE SECRET']);
await alert(Date.parse('2026-10-12T09:00:00Z'), 'critical', 'script_added', 'Nouveau script externe chargé par la page');
await alert(Date.parse('2026-10-13T09:00:00Z'), 'warning', 'title_changed', 'Le titre de la page a changé');
await alert(Date.parse('2026-10-13T09:05:00Z'), 'recovery', 'recovery', 'Rétabli : x');
await alert(Date.parse('2026-10-14T09:05:00Z'), 'info', 'links_added', 'Domaine externe');
await alert(Date.parse('2026-09-12T09:00:00Z'), 'critical', 'forbidden', 'Hors période');
await dbm.setCmsReport(w.id, {
  ok: true, checkedAt: NOW - H, php: '8.1.30', cms: 'wordpress', cmsVersion: '6.8',
  core: { current: '6.8', available: '6.8.3', known: true },
  extensions: [{ name: 'Yoast SEO', slug: 'seo', current: '24.2', available: '25.4', active: true, known: true }], themes: [],
  history: [{ ts: Date.parse('2026-10-15T00:00:00Z'), kind: 'core', name: 'WordPress', from: '6.7.1', to: '6.8' }, { ts: Date.parse('2026-09-15T00:00:00Z'), kind: 'ext', name: 'Ancienne', from: '1', to: '2' }],
  integrity: { checkedAt: NOW - H, ok: true, core: { known: true, modified: [], added: [], missing: [] }, plugins: [{ known: true, modified: ['a.php'], added: [], missing: [] }], uploads: { php: ['x.php'] } },
  admins: { count: 3, added: [{ id: 9 }], extra: 1, recent: [], known: [] },
}, 0);
const watch = await dbm.getWatch(w.id);

test('données du rapport : disponibilité sur le mois, pannes bornées, maintenance, alertes, mises à jour', async () => {
  const range = monthRange('2026-10', 0, NOW);
  const s = await siteReport(watch, range, NOW);
  const expectedDown = 3 * H;
  assert.equal(s.downtime, expectedDown, 'la panne à cheval ne compte que sa part d’octobre');
  assert.equal(s.outageCount, 2);
  assert.ok(Math.abs(s.uptime - 100 * (1 - expectedDown / (31 * D))) < 1e-9, `disponibilité ${s.uptime}`);
  assert.equal(s.longest, 2 * H);
  assert.deepEqual(s.outages.map((o) => [o.start, o.duration, o.startedBefore]), [[OCT, H, true], [Date.parse('2026-10-10T08:00:00Z'), 2 * H, false]]);
  assert.equal(s.days.length, 31);
  assert.equal(s.days[0].outages, 1);
  assert.ok(s.days[0].uptime < 100 && s.days[1].uptime === 100);
  assert.equal(s.maintenanceMs, 2 * H);
  assert.equal(s.response.avg, 300);
  assert.deepEqual([s.alerts.critical, s.alerts.warning, s.alerts.total], [1, 1, 2], 'ni rétablissement, ni info, ni hors période');
  assert.deepEqual(s.alerts.items.map((a) => a.title), ['Le titre de la page a changé', 'Nouveau script externe chargé par la page']);
  assert.equal('detail' in s.alerts.items[0], false, 'jamais le détail technique');
  assert.equal(s.cms.applied.length, 1);
  assert.equal(s.cms.applied[0].to, '6.8');
  assert.equal(s.cms.pending.length, 2);
  assert.equal(s.cms.phpSupport.status, 'ended');
  assert.deepEqual([s.cms.integrity.issues, s.cms.admins.flagged], [2, 2]);

  const sept = await siteReport(watch, monthRange('2026-09', 0, NOW), NOW);
  assert.equal(sept.alerts.total, 1);
  assert.equal(sept.cms.applied.length, 1, 'autre mois, autres mises à jour');
  const before = await siteReport(watch, monthRange('2026-08', 0, NOW), NOW);
  assert.equal(before.uptime, null, 'surveillance pas encore commencée');
});

test('rapport HTML : échappement, mois précédent / suivant, aucun détail technique', async () => {
  const range = monthRange('2026-10', 60, NOW);
  const html = renderReport({ title: 'Cabinet', sites: [await siteReport(watch, range, NOW)], range, nav: { base: '/api/watches/1/report' }, generatedAt: NOW });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<html lang="fr">/);
  assert.match(html, /Rapport mensuel — octobre 2026/);
  assert.match(html, /99,46\d %/, 'fuseau +1 h : la panne à cheval y tient en entier (4 h sur 744)');
  assert.match(html, /Cabinet/);
  assert.doesNotMatch(html, /<script>x<\/script>/, 'la note de maintenance est échappée');
  assert.match(html, /Mise à jour &lt;script&gt;x&lt;\/script&gt;/);
  assert.doesNotMatch(html, /Cabinet <b>/, 'le nom n’est jamais injecté en HTML');
  assert.doesNotMatch(html, /DETAIL TECHNIQUE SECRET/);
  assert.match(html, /href="\/api\/watches\/1\/report\?month=2026-09&amp;tz=60"/);
  assert.match(html, /href="\/api\/watches\/1\/report\?month=2026-11&amp;tz=60"/);
  assert.match(html, /data-print/);
  assert.match(html, /Nouveau script externe chargé par la page/);
  assert.match(html, /WordPress.*6\.7\.1 → <b>6\.8<\/b>/s);
  assert.match(html, /PHP non maintenu/);
  assert.match(html, /2 anomalies/);
  assert.match(html, /Pannes/);
  assert.doesNotMatch(html, /<script(?! src="\/report\.js" defer)/, 'aucun script en ligne');

  const noPrev = monthRange('2026-11', 0, NOW);
  const cur = renderReport({ title: 'x', sites: [await siteReport(watch, noPrev, NOW)], range: noPrev, nav: { base: '/r' }, generatedAt: NOW });
  assert.match(cur, /aria-disabled="true">Mois suivant/);
  assert.match(cur, /mois en cours/);
});

test('rapport d’un groupe : synthèse puis un chapitre par site', async () => {
  const w2 = await dbm.createWatch({ name: 'Autre site', url: 'https://autre.example/', interval: 5, config: { checks: { dns: false, tls: false, rdap: false } } });
  const range = monthRange('2026-10', 0, NOW);
  const html = renderReport({ title: 'Client Martin', sites: [await siteReport(watch, range, NOW), await siteReport(await dbm.getWatch(w2.id), range, NOW)], range, nav: { base: '/api/groups/1/report' }, generatedAt: NOW });
  assert.match(html, /<h2>Synthèse<\/h2>/);
  assert.match(html, /Autre site/);
  assert.equal((html.match(/class="site /g) || []).length, 2);
  const solo = renderReport({ title: 's', sites: [await siteReport(watch, range, NOW)], range, nav: { base: '/r' }, generatedAt: NOW });
  assert.doesNotMatch(solo, /Synthèse/);
});

test('page de statut : état, pannes, maintenance — aucune alerte de sécurité', async () => {
  const live = await dbm.getWatch(w.id);
  const data = await statusData(live, 0, NOW);
  assert.equal(data.state, 'up');
  assert.equal(data.bars.length, 90);
  assert.equal(data.outages.length, 2);
  const html = renderStatusPage({ title: 'Cabinet <i>Martin</i>', host: 'cabinet-martin.example', data, now: NOW });
  assert.match(html, /Tous les systèmes fonctionnent normalement/);
  assert.match(html, /Cabinet &lt;i&gt;Martin&lt;\/i&gt;/);
  assert.match(html, /<meta name="robots" content="noindex,nofollow">/);
  assert.match(html, /http-equiv="refresh" content="60"/);
  assert.doesNotMatch(html, /Nouveau script externe|DETAIL TECHNIQUE|Yoast|admin|intégrité/i);

  const open = await dbm.openOutage(w.id, NOW - 30 * 60e3, 'Connexion refusée');
  const down = await statusData(await dbm.getWatch(w.id), 0, NOW);
  assert.deepEqual([down.state, down.since], ['down', NOW - 30 * 60e3]);
  const downHtml = renderStatusPage({ title: 'x', host: 'x', data: down, now: NOW });
  assert.match(downHtml, /Panne en cours/);
  assert.match(downHtml, /30 min/);
  assert.doesNotMatch(downHtml, /Connexion refusée/, 'la cause technique reste privée');
  await dbm.closeOutage(open, NOW);

  await dbm.addMaintenance({ watchId: w.id, start: NOW - H, end: NOW + H, note: 'Migration' });
  const maint = await statusData(await dbm.getWatch(w.id), 0, NOW);
  assert.equal(maint.state, 'maintenance');
  assert.match(renderStatusPage({ title: 'x', host: 'x', data: maint, now: NOW }), /Maintenance en cours/);

  await dbm.updateWatch(w.id, { enabled: false });
  assert.equal((await statusData(await dbm.getWatch(w.id), 0, NOW)).state, 'paused');
});

test.after(() => dbm.db.close());
