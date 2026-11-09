// Cloisonnement par compte : un compte ne voit, ne modifie ni ne supprime ce qui appartient à un autre.
// Deux comptes (10 et 20 — jamais 1, pour qu'aucun « compte 1 » codé en dur ne passe inaperçu) ; « carol » est un second
// utilisateur du compte 10 : tout ce que voit alice, elle le voit aussi.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'suricate-iso-'));
process.env.CHROME_PATH = '/nonexistent/chrome';

const dbm = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const { isRunning } = await import('../src/scheduler.js');
const { scopedData } = await import('../src/scoped.js');
const { bus } = await import('../src/events.js');

const A = 10;
const B = 20;
const USERS = {
  alice: { user: { id: 1, name: 'alice' }, account: { id: A } },
  carol: { user: { id: 2, name: 'carol' }, account: { id: A } },
  bob: { user: { id: 3, name: 'bob' }, account: { id: B } },
  casse: { user: { id: 4, name: 'casse' }, account: {} }, // fournisseur défaillant : pas d'identifiant de compte
};
const auth = {
  authenticate: (req) => USERS[req.headers['x-user']] ?? null,
  register: ({ route }) => route('GET', '/api/auth', () => ({ authenticated: false }), { public: true }),
};
const app = createApp({ auth });
const port = await app.listen(0, '127.0.0.1');
const base = `http://127.0.0.1:${port}`;

async function call(as, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(as ? { 'x-user': as } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* pas du JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}
const settle = async (id) => { for (let i = 0; i < 200 && isRunning(id); i++) await new Promise((r) => setTimeout(r, 25)); };
const SITE = { url: 'http://127.0.0.1:9/', config: { checks: { dns: false, tls: false, rdap: false }, screenshot: { enabled: false } } };

// ───────────── Données du compte A ─────────────

const group = (await call('alice', 'POST', '/api/groups', { name: 'Clients', color: '#10b981' })).json;
const site = (await call('alice', 'POST', '/api/watches', { ...SITE, name: 'Boutique A', groupId: group.id, config: { ...SITE.config, statusPage: { enabled: true } } })).json;
await settle(site.id);
const alert = await dbm.insertAlert({ watchId: site.id, severity: 'warning', type: 'content_changed', title: 'Contenu modifié', detail: 'secret du compte A' });
const snap1 = await dbm.insertSnapshot(site.id, { hash: 'h1', lines: ['ligne un', 'ligne deux'], title: 'v1', size: 20, meta: {} });
const snap2 = await dbm.insertSnapshot(site.id, { hash: 'h2', lines: ['ligne un', 'ligne trois'], title: 'v2', size: 22, meta: {} });
mkdirSync(join(dbm.SHOTS_DIR, String(site.id)), { recursive: true });
writeFileSync(join(dbm.SHOTS_DIR, `${site.id}/1.jpg`), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
const shot = await dbm.insertScreenshot({ watchId: site.id, ts: Date.now(), kind: 'manual', file: `${site.id}/1.jpg`, size: 4, width: 10, height: 10 });
const maint = (await dbm.addMaintenance({ watchId: site.id, start: Date.now() - 1000, end: Date.now() + 3600e3, note: 'Migration' })).id;
const outage = await dbm.openOutage(site.id, Date.now() - 7200e3, 'Panne ancienne', 503);
await dbm.closeOutage(outage, Date.now() - 3600e3);
const siteA = await dbm.getWatch(site.id);
const token = siteA.config.statusPage.token;

const IDS = { site: site.id, snap: snap1, shot, maint, group: group.id };

// ───────────── Visibilité ─────────────

test('chaque compte ne voit que ses sites, groupes et alertes ; deux utilisateurs d\'un même compte voient la même chose', async () => {
  for (const who of ['alice', 'carol']) {
    assert.deepEqual((await call(who, 'GET', '/api/watches')).json.map((w) => w.name), ['Boutique A'], who);
    assert.deepEqual((await call(who, 'GET', '/api/groups')).json.map((g) => g.name), ['Clients'], who);
    assert.deepEqual((await call(who, 'GET', '/api/alerts')).json.map((a) => a.id), [alert], who);
    assert.equal((await call(who, 'GET', `/api/watches/${site.id}`)).status, 200, who);
  }
  assert.deepEqual((await call('bob', 'GET', '/api/watches')).json, []);
  assert.deepEqual((await call('bob', 'GET', '/api/groups')).json, []);
  assert.deepEqual((await call('bob', 'GET', '/api/alerts')).json, []);
  const exp = (await call('bob', 'GET', '/api/export')).json;
  assert.deepEqual([exp.watches.length, exp.groups.length], [0, 0], 'l\'export ne contient rien du compte A');
  assert.equal((await call('alice', 'GET', '/api/export')).json.watches.length, 1);
});

test('lecture de ses propres ressources : image, versions, comparaison', async () => {
  const img = await fetch(`${base}/api/screenshots/${shot}/image`, { headers: { 'x-user': 'alice' } });
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/jpeg');
  assert.equal((await call('alice', 'GET', `/api/snapshots/${snap2}/diff`)).json.added, 1);
  assert.equal((await call('alice', 'GET', `/api/snapshots/${snap2}/diff?against=${snap1}`)).status, 200);
});

// ───────────── Un autre compte, avec les identifiants du compte A ─────────────

// [méthode, chemin de la route, genre d'identifiant, corps]. Chaque route privée à paramètre y figure : voir le test suivant.
const MATRIX = [
  ['GET', '/api/watches/:id', 'site'], ['PUT', '/api/watches/:id', 'site', { name: 'volé' }], ['DELETE', '/api/watches/:id', 'site'],
  ['POST', '/api/watches/:id/toggle', 'site'], ['POST', '/api/watches/:id/check', 'site'], ['POST', '/api/watches/:id/ack', 'site'],
  ['GET', '/api/watches/:id/uptime', 'site'], ['GET', '/api/watches/:id/series', 'site'], ['GET', '/api/watches/:id/domain', 'site'],
  ['GET', '/api/watches/:id/history', 'site'], ['GET', '/api/watches/:id/screenshots', 'site'], ['POST', '/api/watches/:id/screenshot', 'site'],
  ['POST', '/api/watches/:id/cms', 'site'], ['POST', '/api/watches/:id/cms/admins/accept', 'site'], ['GET', '/api/watches/:id/report', 'site'],
  ['POST', '/api/watches/:id/maintenance', 'site', { minutes: 30 }],
  ['GET', '/api/snapshots/:id/diff', 'snap'], ['GET', '/api/snapshots/:id/text', 'snap'],
  ['GET', '/api/screenshots/:id/image', 'shot'], ['DELETE', '/api/maintenance/:id', 'maint'],
  ['PUT', '/api/groups/:id', 'group', { name: 'volé' }], ['DELETE', '/api/groups/:id', 'group'], ['GET', '/api/groups/:id/report', 'group'],
];

test('garde : toute route privée à paramètre est dans la matrice d\'isolation (une nouvelle route doit y être ajoutée)', () => {
  const connues = new Set(MATRIX.map(([m, p]) => `${m} ${p}`));
  const aCouvrir = app.routes().filter((r) => !r.public && r.path.includes(':') && r.path !== '/api/plugins/:file').map((r) => `${r.method} ${r.path}`);
  assert.deepEqual(aCouvrir.filter((r) => !connues.has(r)), [], 'route à paramètre absente de la matrice');
  assert.deepEqual([...connues].filter((r) => !aCouvrir.includes(r)), [], 'entrée de la matrice sans route correspondante');
});

for (const [method, path, kind, body] of MATRIX) {
  test(`isolation : ${method} ${path} avec l'identifiant d'un autre compte → 404, rien n'est touché`, async () => {
    const url = path.replace(':id', IDS[kind]);
    const r = await call('bob', method, url, body);
    assert.equal(r.status, 404, `${method} ${url} → ${r.status} ${r.text.slice(0, 120)}`);
    assert.ok(!/secret du compte A|Boutique A|Clients/.test(r.text), 'la réponse ne révèle rien du compte A');
  });
}

test('après toutes ces tentatives, les données du compte A sont intactes', async () => {
  const w = await dbm.getWatch(site.id);
  assert.deepEqual([w.name, w.enabled, w.groupId, w.accountId], ['Boutique A', true, group.id, A]);
  assert.equal((await dbm.getGroup(group.id)).name, 'Clients');
  assert.ok(await dbm.getScreenshot(shot), 'capture conservée');
  assert.ok((await dbm.activeMaintenance(site.id)), 'la maintenance du compte A est toujours en cours');
  assert.equal((await dbm.getMaintenance(maint)).end > Date.now(), true);
  assert.equal((await dbm.listMaintenance(site.id)).length, 1, 'aucune fenêtre ajoutée par le compte B');
});

test('alertes : le compte B ne lit ni ne marque les alertes du compte A, même en les désignant', async () => {
  assert.deepEqual((await call('bob', 'GET', `/api/alerts?watch=${site.id}`)).json, []);
  assert.equal((await call('bob', 'POST', '/api/alerts/read', { ids: [alert] })).status, 200);
  assert.equal((await call('bob', 'POST', '/api/alerts/read', { all: true })).status, 200);
  const row = await dbm.db.get('SELECT read FROM alerts WHERE id = ?', [alert]);
  assert.equal(row.read, 0, 'l\'alerte du compte A reste non lue');
  // Le compte A, lui, peut la marquer.
  assert.equal((await call('carol', 'POST', '/api/alerts/read', { ids: [alert] })).status, 200);
  assert.equal((await dbm.db.get('SELECT read FROM alerts WHERE id = ?', [alert])).read, 1);
  await dbm.db.run('UPDATE alerts SET read = 0 WHERE id = ?', [alert]); // remis pour la suite
});

test('organisation : le compte B ne peut pas ranger les sites ni les groupes du compte A', async () => {
  const r = await call('bob', 'PUT', '/api/layout', { groups: [group.id], items: [{ groupId: group.id, ids: [site.id] }] });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /inconnu/i);
  assert.equal((await dbm.getWatch(site.id)).groupId, group.id);
  // …ni y ranger son propre site
  const mine = (await call('bob', 'POST', '/api/watches', { ...SITE, url: 'http://127.0.0.1:9/site-b', name: 'Site B' })).json;
  await settle(mine.id);
  assert.equal((await call('bob', 'PUT', `/api/watches/${mine.id}`, { groupId: group.id })).status, 400, 'groupe d\'un autre compte = inconnu');
  assert.equal((await call('bob', 'POST', '/api/watches', { ...SITE, name: 'Autre', groupId: group.id })).status, 400);
});

test('tableau de bord : les chiffres d\'un compte ne comptent que ses sites (alertes, captures, maintenance)', async () => {
  const a = (await call('alice', 'GET', '/api/watches')).json[0];
  assert.equal(a.unread.warning, 1);
  assert.ok(a.shot, 'capture du compte A');
  assert.ok(a.maintenanceUntil, 'maintenance du compte A');
  const bobSites = (await call('bob', 'GET', '/api/watches')).json;
  assert.deepEqual(bobSites.map((w) => w.name), ['Site B']);
  assert.deepEqual([bobSites[0].unread, bobSites[0].shot, bobSites[0].maintenanceUntil], [{ critical: 0, warning: 0, info: 0 }, null, null]);
  assert.equal((await call('alice', 'GET', '/api/settings')).json.screenshots.usage.count, 1);
  assert.equal((await call('bob', 'GET', '/api/settings')).json.screenshots.usage.count, 0, 'l\'usage des captures est par compte');
});

test('groupes : même nom autorisé dans deux comptes, rangs indépendants', async () => {
  const g = await call('bob', 'POST', '/api/groups', { name: 'clients' }); // même nom que le groupe du compte A, casse différente
  assert.equal(g.status, 200);
  assert.equal(g.json.position, 1, 'premier groupe du compte B : rang 1, quel que soit le compte A');
  assert.equal((await call('bob', 'POST', '/api/groups', { name: 'Clients' })).status, 409, 'mais pas deux fois dans le même compte');
  assert.equal((await call('alice', 'POST', '/api/groups', { name: 'CLIENTS' })).status, 409);
  assert.equal((await call('bob', 'DELETE', `/api/groups/${g.json.id}`)).status, 200);
  assert.equal((await dbm.getGroup(group.id)).position, 1, 'supprimer un groupe du compte B ne renumérote pas ceux du compte A');
});

test('import : les groupes sont retrouvés par nom DANS le compte ; les sites vont au compte qui importe', async () => {
  const r = await call('bob', 'POST', '/api/import', { watches: [{ name: 'Importé', url: 'http://127.0.0.1:9/import', group: 'Clients' }] });
  assert.equal(r.json.added, 1);
  const imported = (await dbm.listWatches(B)).find((w) => w.name === 'Importé');
  await settle(imported.id);
  assert.equal(imported.accountId, B);
  const groupOfImported = await dbm.getGroup(imported.groupId);
  assert.equal(groupOfImported.accountId, B, 'un nouveau groupe « Clients » a été créé pour le compte B');
  assert.notEqual(groupOfImported.id, group.id, 'sans jamais rattacher le site au groupe du compte A');
  assert.equal((await dbm.getWatch(site.id)).groupId, group.id);
  // même adresse que le site du compte A : pas un doublon pour le compte B
  const same = await call('bob', 'POST', '/api/import', { watches: [{ name: 'Même adresse', url: SITE.url }] });
  assert.equal(same.json.added, 1, 'la détection de doublons se fait dans le compte');
  for (const w of await dbm.listWatches(B)) await settle(w.id);
});

test('page de statut : un jeton ne peut pas être pris à un autre compte ; la page publique reste lisible sans connexion', async () => {
  const mine = (await dbm.listWatches(B)).find((w) => w.name === 'Site B');
  const put = await call('bob', 'PUT', `/api/watches/${mine.id}`, { config: { statusPage: { enabled: true, token } } });
  assert.equal(put.status, 200);
  const after = (await call('bob', 'GET', `/api/watches/${mine.id}`)).json.config.statusPage;
  assert.notEqual(after.token, token, 'le jeton du compte A a été remplacé par un jeton neuf');
  assert.match(after.token, /^[A-Za-z0-9_-]{16,64}$/);
  const page = await fetch(`${base}/status/${token}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Boutique A/, 'le jeton du compte A désigne toujours son site');
});

test('compte invalide : un fournisseur qui ne donne pas d\'identifiant de compte entier est refusé (500, jamais « compte 1 » par défaut)', async () => {
  const origError = console.error;
  console.error = () => {};
  try {
    assert.equal((await call('casse', 'GET', '/api/watches')).status, 500);
  } finally {
    console.error = origError;
  }
  for (const bad of [undefined, null, 0, -1, 1.5, '10', NaN]) assert.throws(() => scopedData(bad), /invalide/, String(bad));
});

test('compte implicite : le cœur (identifiants du .env) travaille dans le compte 1, comme avant', async () => {
  const w = await dbm.createWatch({ name: 'Ancien site', url: 'http://127.0.0.1:9/ancien', interval: 60, config: SITE.config });
  assert.equal(w.accountId, 1);
  const g = await dbm.createGroup({ name: 'Ancien groupe' });
  assert.equal(g.accountId, 1);
  const core = createApp({ env: { SURICATE_USER: 'u', SURICATE_PASSWORD: 'motdepasse-solide' } });
  const p = await core.listen(0, '127.0.0.1');
  try {
    const login = await fetch(`http://127.0.0.1:${p}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'u', password: 'motdepasse-solide' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const list = await (await fetch(`http://127.0.0.1:${p}/api/watches`, { headers: { cookie } })).json();
    assert.deepEqual(list.map((x) => x.name), ['Ancien site'], 'le compte 1 ne voit ni le compte A ni le compte B');
  } finally {
    await core.stop();
  }
});

// ───────────── Flux temps réel ─────────────

/** Ouvre le flux d'événements d'un utilisateur ; stop() le ferme et renvoie les événements reçus, dans l'ordre. */
async function listen(who) {
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/events`, { headers: { 'x-user': who }, signal: ctrl.signal });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  let text = '';
  const reading = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      }
    } catch { /* flux fermé */ }
  })();
  return {
    stop: async () => {
      await new Promise((r) => setTimeout(r, 100)); // laisse arriver les derniers événements (recherche du compte asynchrone)
      ctrl.abort();
      await reading;
      return [...text.matchAll(/^data: (.*)$/gm)].map((m) => JSON.parse(m[1]));
    },
  };
}

test('temps réel : chaque utilisateur ne reçoit que les événements de SON compte, dans l\'ordre', async () => {
  const bobSite = (await dbm.listWatches(B))[0].id;
  const [alice, carol, bob] = [await listen('alice'), await listen('carol'), await listen('bob')];
  await new Promise((r) => setTimeout(r, 50));
  bus.emit('event', { type: 'running', watchId: site.id });
  bus.emit('event', { type: 'layout', accountId: A });
  bus.emit('event', { type: 'ack', accountId: B });
  bus.emit('event', { type: 'check', watchId: bobSite, alerts: 0 });
  bus.emit('event', { type: 'check', watchId: site.id, alerts: 0 });
  bus.emit('event', { type: 'idle', watchId: 987654321 }); // site inconnu : transmis à personne
  bus.emit('event', { type: 'sans-compte' }); // ni compte ni site : transmis à personne
  const got = async (l) => (await l.stop()).map((e) => e.type);
  assert.deepEqual(await got(alice), ['running', 'layout', 'check'], 'compte A (alice)');
  assert.deepEqual(await got(carol), ['running', 'layout', 'check'], 'compte A (carol, autre utilisateur du même compte)');
  assert.deepEqual(await got(bob), ['ack', 'check'], 'compte B');
});

// ───────────── Garde statique ─────────────

test('garde : les routes n\'importent pas les fonctions de db.js qui lisent ou écrivent par identifiant ou par liste (ctx.data)', () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'routes');
  const INTERDITES = new Set([
    'listWatches', 'createWatch', 'listGroups', 'getGroup', 'createGroup', 'updateGroup', 'deleteGroup', 'applyLayout',
    'getSnapshot', 'getScreenshot', 'endMaintenance', 'getMaintenance', 'queryAlerts', 'markEveryAlertRead', 'markAlertsRead',
    'unreadAlertCounts', 'domainExpiryAlertState', 'checkStatsSince', 'sparklines', 'latestScreenshots', 'activeMaintenanceMap', 'screenshotUsage',
  ]);
  const fautes = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const src = readFileSync(join(dir, f), 'utf8');
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\.\/db\.js'/g)) {
      for (const n of m[1].split(',').map((x) => x.trim()).filter(Boolean)) {
        // getWatch n'est permis que dans shared.js : rememberDomainAck reçoit un identifiant déjà contrôlé.
        if (INTERDITES.has(n) || (n === 'getWatch' && f !== 'shared.js')) fautes.push(`${f} importe ${n}`);
      }
    }
  }
  assert.deepEqual(fautes, [], 'passer par ctx.data (src/scoped.js)');
});

test.after(async () => {
  await app.stop();
  dbm.db.close();
});
