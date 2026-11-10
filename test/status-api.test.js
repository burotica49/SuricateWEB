import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../test-support/server.js';

// Page de statut publique, rapports mensuels et pages supplémentaires, par l'API.
const srv = await startServer();
test.after(() => srv.stop());

const create = async (name, extra = {}) => {
  const r = await srv.post('/api/watches', { url: `https://${name.toLowerCase().replace(/\W/g, '')}.test/`, name, enabled: false, ...extra });
  assert.equal(r.status, 200, r.text);
  return r.json;
};
const detail = async (id) => (await srv.get(`/api/watches/${id}`)).json;
/** Requête publique : aucun cookie de session. */
const publicGet = (path) => fetch(srv.base + path);

test('page de statut : activée, un jeton aléatoire est créé et la page se lit sans connexion', async () => {
  const w = await create('Cabinet Martin', { config: { statusPage: { enabled: true, title: 'Cabinet <Martin>' } } });
  const cfg = (await detail(w.id)).config.statusPage;
  assert.equal(cfg.enabled, true);
  assert.match(cfg.token, /^[A-Za-z0-9_-]{24}$/);

  const res = await publicGet(`/status/${cfg.token}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/html/);
  assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
  assert.equal(res.headers.get('set-cookie'), null);
  const html = await res.text();
  assert.match(html, /Cabinet &lt;Martin&gt;/);
  assert.match(html, /cabinetmartin\.test/);
  assert.match(html, /Surveillance en pause/, 'site en pause');
  assert.doesNotMatch(html, /cms|token|jeton/i);
  assert.equal((await publicGet(`/status/${cfg.token}/`)).status, 200);
});

test('page de statut : jeton inconnu, site désactivé ou page coupée → 404 identique', async () => {
  const w = await create('Autre', { config: { statusPage: { enabled: true } } });
  const token = (await detail(w.id)).config.statusPage.token;
  assert.equal((await publicGet('/status/abcdefghijklmnopqrstuvwx')).status, 404);
  assert.equal((await publicGet('/status/court')).status, 404);
  assert.equal((await publicGet('/status/' + 'a'.repeat(200))).status, 404);
  assert.equal((await publicGet('/status/')).status, 404);
  const off = await srv.put(`/api/watches/${w.id}`, { config: { statusPage: { enabled: false, token } } });
  assert.equal(off.status, 200);
  const res = await publicGet(`/status/${token}`);
  assert.equal(res.status, 404, 'page coupée : l’adresse ne répond plus');
  assert.doesNotMatch(await res.text(), /Autre/);
  const on = await srv.put(`/api/watches/${w.id}`, { config: { statusPage: { enabled: true, token } } });
  assert.equal(on.status, 200);
  assert.equal((await publicGet(`/status/${token}`)).status, 200, 'le même jeton revient avec la page');
});

test('page de statut : nouvelle adresse, jeton jamais partagé entre deux sites, domaine seul exclu', async () => {
  const a = await create('Site A', { config: { statusPage: { enabled: true } } });
  const tokenA = (await detail(a.id)).config.statusPage.token;
  const fresh = 'N'.repeat(30);
  const b = await create('Site B', { config: { statusPage: { enabled: true, token: tokenA } } });
  const tokenB = (await detail(b.id)).config.statusPage.token;
  assert.notEqual(tokenB, tokenA, 'un jeton déjà pris est remplacé');
  assert.match(tokenB, /^[A-Za-z0-9_-]{24}$/);

  const renew = await srv.put(`/api/watches/${a.id}`, { config: { statusPage: { enabled: true, token: fresh } } });
  assert.equal(renew.status, 200);
  assert.equal((await publicGet(`/status/${tokenA}`)).status, 404, 'l’ancienne adresse cesse de fonctionner');
  assert.equal((await publicGet(`/status/${fresh}`)).status, 200);

  const bad = await srv.put(`/api/watches/${a.id}`, { config: { statusPage: { enabled: true, token: 'trop court!' } } });
  assert.equal(bad.status, 200);
  assert.match((await detail(a.id)).config.statusPage.token, /^[A-Za-z0-9_-]{24}$/, 'jeton invalide : un nouveau est généré');

  const dom = await create('exemple', { url: 'exemple-domaine.test', config: { mode: 'domain', statusPage: { enabled: true } } });
  assert.equal((await detail(dom.id)).config.statusPage.enabled, false);
});

test('rapports : connexion obligatoire, mois validé, HTML imprimable', async () => {
  const w = await create('Rapporté');
  const month = new Date().toISOString().slice(0, 7);
  srv.logout();
  assert.equal((await srv.get(`/api/watches/${w.id}/report`)).status, 401);
  assert.equal((await srv.get('/api/groups/1/report')).status, 401);
  assert.equal(await srv.login(), 200);

  const ok = await srv.get(`/api/watches/${w.id}/report?tz=60`);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type'), /^text\/html/);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.match(ok.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(ok.text, /Rapport mensuel — /);
  assert.match(ok.text, /Rapporté/);
  assert.match(ok.text, new RegExp(`/api/watches/${w.id}/report\\?month=\\d{4}-\\d{2}&amp;tz=60`));

  assert.equal((await srv.get(`/api/watches/${w.id}/report?month=${month}`)).status, 200, 'le mois en cours est permis');
  for (const bad of ['2999-01', 'abc', '2026-13', '2026-1']) {
    const r = await srv.get(`/api/watches/${w.id}/report?month=${bad}`);
    assert.equal(r.status, 400, bad);
    assert.match(r.json.error, /Mois invalide/);
  }
  assert.equal((await srv.get('/api/watches/99999/report')).status, 404);
  assert.match((await srv.get('/report.js')).text, /window\.print/, 'le script du bouton Imprimer est servi');
});

test('rapports de groupe : un chapitre par site, groupe vide ou inconnu refusés', async () => {
  const g = (await srv.post('/api/groups', { name: 'Client Dupont' })).json;
  const empty = (await srv.post('/api/groups', { name: 'Vide' })).json;
  await create('Dupont Un', { groupId: g.id });
  await create('Dupont Deux', { groupId: g.id });
  const r = await srv.get(`/api/groups/${g.id}/report?month=2020-01`);
  assert.equal(r.status, 200, r.text);
  assert.match(r.text, /Client Dupont/);
  assert.match(r.text, /Dupont Un/);
  assert.match(r.text, /Dupont Deux/);
  assert.match(r.text, /Synthèse/);
  assert.equal((await srv.get(`/api/groups/${empty.id}/report`)).status, 400);
  assert.equal((await srv.get('/api/groups/9999/report')).status, 404);
});

test('pages supplémentaires : enregistrées, validées, renvoyées avec leur état', async () => {
  const w = await create('Boutique', { url: 'https://www.boutique.test/', config: { pages: ['/panier | Panier', { url: 'https://compte.boutique.test/login', label: 'Connexion' }] } });
  const d = await detail(w.id);
  assert.deepEqual(d.config.pages, [{ url: '/panier', label: 'Panier' }, { url: 'https://compte.boutique.test/login', label: 'Connexion' }]);
  assert.deepEqual(d.pages.map((p) => [p.label, p.href, p.state]), [['Panier', 'https://www.boutique.test/panier', null], ['Connexion', 'https://compte.boutique.test/login', null]]);

  const off = await srv.post('/api/watches', { url: 'https://www.boutique2.test/', name: 'X', enabled: false, config: { pages: ['https://pirate.example/panier'] } });
  assert.equal(off.status, 400);
  assert.match(off.json.error, /Page invalide ou extérieure au site : https:\/\/pirate\.example\/panier/);
  const js = await srv.post('/api/watches', { url: 'https://www.boutique3.test/', name: 'Y', enabled: false, config: { pages: ['javascript:alert(1)'] } });
  assert.equal(js.status, 400);
  const move = await srv.put(`/api/watches/${w.id}`, { url: 'https://autre-domaine.test/', config: { pages: ['/panier'] } });
  assert.equal(move.status, 200, 'les pages relatives suivent la nouvelle adresse');
  const move2 = await srv.put(`/api/watches/${w.id}`, { url: 'https://encore-un-autre.test/', config: { pages: ['https://compte.boutique.test/login'] } });
  assert.equal(move2.status, 400, 'une page absolue d’un autre site est refusée');

  const dom = await create('Domaine seul', { url: 'domaine-seul.test', config: { mode: 'domain', pages: ['/x'] } });
  assert.deepEqual((await detail(dom.id)).config.pages, []);
});

test('administrateurs : acceptation refusée sans relevé ni site', async () => {
  const w = await create('Sans relevé');
  assert.equal((await srv.post(`/api/watches/${w.id}/cms/admins/accept`)).status, 400);
  assert.equal((await srv.post('/api/watches/9999/cms/admins/accept')).status, 404);
  srv.logout();
  assert.equal((await srv.post(`/api/watches/${w.id}/cms/admins/accept`)).status, 401);
  assert.equal(await srv.login(), 200);
});

test('code suspect : « Je connais ce fichier » refusé sans relevé, sans site, sans session', async () => {
  const w = await create('Sans analyse de code');
  assert.equal((await srv.post(`/api/watches/${w.id}/cms/code/accept`, { path: 'a.php' })).status, 400);
  assert.equal((await srv.post('/api/watches/9999/cms/code/accept')).status, 404);
  srv.logout();
  assert.equal((await srv.post(`/api/watches/${w.id}/cms/code/accept`)).status, 401);
  assert.equal(await srv.login(), 200);
});

test('page de statut : limitation du débit par adresse', async () => {
  let last = 0;
  for (let i = 0; i < 130; i++) last = (await publicGet('/status/abcdefghijklmnopqrstuvwx')).status;
  assert.equal(last, 429);
});

test('« Tout est normal » acquitte aussi les incidents Mises à jour / Sécurité, sans effacer relevé ni alertes', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const w = await create('Acquit');
  const db = new DatabaseSync(`${srv.dataDir}/suricate.db`);
  const state = { incidents: {
    cms_core: { severity: 'warning', title: 'WordPress 6.8 disponible', detail: '', since: 1 },
    cms_integrity_uploads: { severity: 'critical', title: 'PHP dans uploads', detail: '', since: 1, count: 1 },
  }, cms: { ok: true, checkedAt: 1, core: { current: '6.7' }, extensions: [], themes: [] } };
  db.prepare('UPDATE watches SET state = ?, last_check = 1 WHERE id = ?').run(JSON.stringify(state), w.id);
  db.prepare("INSERT INTO alerts(watch_id, ts, severity, type, title, read) VALUES(?,?,?,?,?,0)").run(w.id, Date.now(), 'critical', 'cms_integrity_uploads', 'PHP dans uploads');
  const open = async () => (await detail(w.id)).incidents.filter((i) => !i.acked).map((i) => i.key);
  assert.deepEqual((await open()).sort(), ['cms_core', 'cms_integrity_uploads']);
  assert.equal((await srv.post(`/api/watches/${w.id}/ack`)).status, 200);
  const d = await detail(w.id);
  assert.deepEqual(await open(), [], 'cartes retirées');
  assert.ok(!['warning', 'critical', 'down'].includes(d.status), 'le site n’est plus en alerte');
  assert.equal(d.cms.core.current, '6.7', 'relevé conservé');
  assert.equal((await srv.get(`/api/alerts?watch=${w.id}`)).json.length, 1, 'alerte conservée dans l’historique');
  // Un incident qui grossit réapparaît
  state.incidents.cms_integrity_uploads.count = 3;
  db.prepare('UPDATE watches SET state = ? WHERE id = ?').run(JSON.stringify({ ...JSON.parse(db.prepare('SELECT state FROM watches WHERE id = ?').get(w.id).state), incidents: state.incidents }), w.id);
  assert.deepEqual(await open(), ['cms_integrity_uploads']);
  db.close();
});
