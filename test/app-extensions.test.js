// createApp (src/app.js) : comportement par défaut du cœur, et points d'extension de la version hébergée
// (authentification, droits, quotas, routes, hooks, capacités).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'suricate-app-'));
process.env.CHROME_PATH = '/nonexistent/chrome';

const dbm = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const { HttpError } = await import('../src/http.js');
const { isRunning } = await import('../src/scheduler.js');
const { resetExtensions } = await import('../src/extensions.js');

const apps = [];
/** Démarre une application sur un port libre ; renvoie un petit client (en-têtes personnalisables). */
async function start(options = {}) {
  const app = createApp(options);
  const port = await app.listen(0, '127.0.0.1');
  apps.push(app);
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, path, { as, body, cookie } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { ...(as ? { 'x-user': as } : {}), ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* pas du JSON */ }
    return { status: res.status, json, text, headers: res.headers };
  };
  return { app, base, call };
}
/** Un contrôle part en tâche de fond à la création d'un site : on l'attend avant de poursuivre (et de fermer la base). */
const settle = async (id) => { for (let i = 0; i < 200 && isRunning(id); i++) await new Promise((r) => setTimeout(r, 25)); };

test.afterEach(async () => {
  while (apps.length) await apps.pop().stop();
  resetExtensions();
  // Chaque test repart d'une base sans site : les quotas comptent les sites existants.
  for (const w of await dbm.listWatches()) {
    await settle(w.id);
    await dbm.deleteWatch(w.id);
  }
});

// ── Fournisseur d'authentification de test : l'en-tête « x-user » désigne l'utilisateur ──
const USERS = {
  alice: { user: { id: 7, name: 'alice' }, account: { id: 70, name: 'Société A' } },
  bob: { user: { id: 8, name: 'bob' }, account: { id: 70, name: 'Société A' } },
};
const fakeAuth = () => ({
  kind: 'test',
  authenticate: (req) => USERS[req.headers['x-user']] ?? null,
  register({ route }) {
    route('GET', '/api/auth', () => ({ required: true, authenticated: false }), { public: true });
  },
});
const SITE = { url: 'http://127.0.0.1:9/', config: { checks: { dns: false, tls: false, rdap: false }, screenshot: { enabled: false } } };

// ───────────── Valeurs par défaut du cœur ─────────────

test('cœur : sans identifiants dans l\'environnement, l\'application refuse de démarrer', () => {
  assert.throws(() => createApp({ env: {} }), /SURICATE_PASSWORD/);
  assert.throws(() => createApp({ env: { SURICATE_PASSWORD: 'court' } }), /trop court/);
});

test('cœur : un compte, identifiants du .env, cookie de session ; tout est permis, aucune limite', async () => {
  const { call } = await start({ env: { SURICATE_USER: 'patron', SURICATE_PASSWORD: 'motdepasse-solide' } });
  assert.equal((await call('GET', '/api/auth')).json.authenticated, false);
  assert.equal((await call('GET', '/api/me')).status, 401);
  assert.equal((await call('POST', '/api/login', { body: { username: 'patron', password: 'faux' } })).status, 401);

  const login = await call('POST', '/api/login', { body: { username: 'patron', password: 'motdepasse-solide' } });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const me = (await call('GET', '/api/me', { cookie })).json;
  assert.equal(me.user.name, 'patron');
  assert.equal(me.account.id, 1, 'installation à compte unique');
  assert.equal((await call('GET', '/api/settings', { cookie })).json.authUser, 'patron', 'l\'identifiant affiché vient de l\'utilisateur connecté');

  const caps = (await call('GET', '/api/capabilities')).json;
  assert.deepEqual({ mode: caps.mode, multiUser: caps.multiUser, billing: caps.billing }, { mode: 'self-hosted', multiUser: false, billing: false });
  assert.match(caps.version, /^\d+\.\d+\.\d+$/);
});

test('garde : toute route privée du cœur déclare une permission (une nouvelle route ne peut pas oublier de le faire)', async () => {
  const { app } = await start({ env: { SURICATE_USER: 'u', SURICATE_PASSWORD: 'motdepasse-solide' } });
  const sans = app.routes().filter((r) => !r.public && !r.perm).map((r) => `${r.method} ${r.path}`);
  assert.deepEqual(sans, ['GET /api/me'], 'seule la lecture de sa propre identité n\'a pas de permission');
  const publiques = app.routes().filter((r) => r.public).map((r) => `${r.method} ${r.path}`).sort();
  assert.deepEqual(publiques, ['GET /api/auth', 'GET /api/capabilities', 'POST /api/login', 'POST /api/logout']);
});

test('arrêt : stop() aboutit même avec un flux temps réel (SSE) ouvert', async () => {
  const { app, base } = await start({ auth: fakeAuth() });
  const res = await fetch(`${base}/api/events`, { headers: { 'x-user': 'alice' } });
  assert.equal(res.status, 200);
  const stopped = await Promise.race([app.stop().then(() => 'arrêté'), new Promise((r) => setTimeout(() => r('bloqué'), 3000))]);
  assert.equal(stopped, 'arrêté');
  apps.pop();
});

// ───────────── Authentification ─────────────

test('auth : le fournisseur décide ; sans identité = 401, routes publiques ouvertes ; ctx.user / ctx.account exposés', async () => {
  const { call } = await start({ auth: fakeAuth() });
  assert.equal((await call('GET', '/api/watches')).status, 401);
  assert.equal((await call('GET', '/api/auth')).status, 200);
  assert.equal((await call('GET', '/api/capabilities')).status, 200);
  const me = (await call('GET', '/api/me', { as: 'alice' })).json;
  assert.deepEqual(me, USERS.alice);
  assert.equal((await call('GET', '/api/me', { as: 'inconnu' })).status, 401);
});

test('auth : un fournisseur peut être asynchrone', async () => {
  const auth = { ...fakeAuth(), authenticate: async (req) => { await new Promise((r) => setTimeout(r, 5)); return USERS[req.headers['x-user']] ?? null; } };
  const { call } = await start({ auth });
  assert.equal((await call('GET', '/api/me', { as: 'bob' })).json.user.name, 'bob');
});

// ───────────── Droits ─────────────

test('authorize : appelé avec l\'action de la route ; refus = 403 « Accès refusé » ; lecture inchangée', async () => {
  const asked = [];
  const authorize = (ctx, action) => {
    asked.push(`${ctx.user.name}:${action}`);
    return !(ctx.user.name === 'bob' && /:(create|update|delete|write)$/.test(action));
  };
  const { call } = await start({ auth: fakeAuth(), authorize });
  assert.equal((await call('GET', '/api/watches', { as: 'bob' })).status, 200);
  const refus = await call('POST', '/api/watches', { as: 'bob', body: SITE });
  assert.deepEqual([refus.status, refus.json.error], [403, 'Accès refusé']);
  assert.equal((await call('PUT', '/api/settings', { as: 'bob', body: { defaultInterval: 20 } })).status, 403);
  assert.equal((await call('PUT', '/api/layout', { as: 'bob', body: {} })).status, 403);
  assert.ok(asked.includes('bob:site:read') && asked.includes('bob:site:create') && asked.includes('bob:settings:write') && asked.includes('bob:group:write'), asked.join(' '));
  // alice (autorisée) crée bien un site : le refus de bob n'a rien laissé derrière lui
  assert.equal((await dbm.listWatches()).length, 0);
  const ok = await call('POST', '/api/watches', { as: 'alice', body: SITE });
  assert.equal(ok.status, 200);
  await settle(ok.json.id);
});

test('authorize : refuser avant de lire le corps — un refus ne consomme pas la requête ni ne touche aux données', async () => {
  const { call } = await start({ auth: fakeAuth(), authorize: () => false });
  const r = await call('POST', '/api/groups', { as: 'alice', body: { name: 'Interdit' } });
  assert.equal(r.status, 403);
  assert.equal((await dbm.listGroups()).length, 0);
});

test('ctx.can / ctx.require : disponibles pour les routes des extensions, avec la ressource', async () => {
  const seen = [];
  const authorize = (ctx, action, resource) => { seen.push([action, resource]); return resource?.siteId !== 99; };
  const routes = [({ route }) => {
    route('GET', '/api/cloud/site/:id', async (ctx) => {
      await ctx.require('cloud:site', { siteId: Number(ctx.params.id) });
      return { vu: true, peut: await ctx.can('cloud:site', { siteId: 1 }) };
    }, { perm: 'cloud:access' });
  }];
  const { call } = await start({ auth: fakeAuth(), authorize, routes });
  const ok = await call('GET', '/api/cloud/site/5', { as: 'alice' });
  assert.deepEqual(ok.json, { vu: true, peut: true });
  assert.equal((await call('GET', '/api/cloud/site/99', { as: 'alice' })).status, 403);
  assert.deepEqual(seen[0], ['cloud:access', undefined], 'la permission de la route est vérifiée d\'abord, sans ressource');
});

// ───────────── Quotas ─────────────

test('entitlements : check() refuse (HttpError 402) à la création, à l\'import et à la reprise ; limits() borne l\'intervalle', async () => {
  const LIMIT = 2;
  const entitlements = {
    check: async (ctx, action) => {
      const n = (await dbm.listWatches()).filter((w) => action === 'site:enable' ? w.enabled : true).length;
      if ((action === 'site:create' || action === 'site:enable') && n >= LIMIT) throw new HttpError(402, `Votre forfait est limité à ${LIMIT} sites`);
    },
    limits: () => ({ minIntervalMin: 30 }),
  };
  const { call } = await start({ auth: fakeAuth(), entitlements });

  const a = await call('POST', '/api/watches', { as: 'alice', body: { ...SITE, name: 'A', interval: 5 } });
  assert.equal(a.status, 200);
  assert.equal(a.json.interval, 30, 'intervalle de 5 min ramené au minimum du forfait (30)');
  const b = await call('POST', '/api/watches', { as: 'alice', body: { ...SITE, name: 'B', interval: 60 } });
  assert.equal(b.json.interval, 60, 'un intervalle plus long est respecté');
  for (const r of [a, b]) await settle(r.json.id);

  const c = await call('POST', '/api/watches', { as: 'alice', body: { ...SITE, name: 'C' } });
  assert.deepEqual([c.status, c.json.error], [402, 'Votre forfait est limité à 2 sites']);
  assert.equal((await dbm.listWatches()).length, 2, 'le site refusé n\'a pas été créé');

  // Import : au-delà du quota, les sites sont ignorés (comptés en « skipped »), pas d'erreur globale.
  const imp = await call('POST', '/api/import', { as: 'alice', body: { watches: [{ name: 'D', url: 'http://d.test/' }, { name: 'E', url: 'http://e.test/' }] } });
  assert.deepEqual([imp.status, imp.json.added, imp.json.skipped], [200, 0, 2]);

  // Reprise : un site en pause (ancien, ou mis en pause par le forfait) ne peut pas être repris au-delà du quota.
  const ancien = await dbm.createWatch({ name: 'Ancien', url: SITE.url, interval: 60, enabled: false, config: SITE.config, accountId: USERS.alice.account.id });
  const bloque = await call('POST', `/api/watches/${ancien.id}/toggle`, { as: 'alice' });
  assert.deepEqual([bloque.status, bloque.json.error], [402, 'Votre forfait est limité à 2 sites']);
  assert.equal((await dbm.getWatch(ancien.id)).enabled, false, 'le site refusé reste en pause');

  // Mettre un site en pause n'est jamais refusé, et libère une place pour en reprendre un autre.
  assert.equal((await call('POST', `/api/watches/${a.json.id}/toggle`, { as: 'alice' })).json.enabled, false);
  const repris = await call('POST', `/api/watches/${ancien.id}/toggle`, { as: 'alice' });
  assert.equal(repris.status, 200);
  assert.equal(repris.json.enabled, true);
  await settle(ancien.id);
});

test('entitlements : par défaut, aucune limite (le cœur)', async () => {
  const { call } = await start({ auth: fakeAuth() });
  for (let i = 0; i < 4; i++) {
    const r = await call('POST', '/api/watches', { as: 'alice', body: { ...SITE, name: `S${i}`, interval: 1 } });
    assert.equal(r.status, 200);
    assert.equal(r.json.interval, 1, 'intervalle minimal du cœur : 1 minute');
    await settle(r.json.id);
  }
});

// ───────────── Hooks, routes, capacités ─────────────

test('hooks : création, modification, suppression ; une erreur de hook n\'empêche jamais la requête', async () => {
  const events = [];
  const origError = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(' '));
  try {
    const hooks = {
      onWatchCreated: (ctx, w) => { events.push(['créé', ctx.user.name, w.name]); },
      onWatchUpdated: async () => { throw new Error('hook cassé'); },
      onWatchDeleted: (ctx, id) => { events.push(['supprimé', ctx.account.id, id]); },
    };
    const { call } = await start({ auth: fakeAuth(), hooks });
    const created = await call('POST', '/api/watches', { as: 'alice', body: { ...SITE, name: 'Hooké' } });
    const id = created.json.id;
    await settle(id);
    const upd = await call('PUT', `/api/watches/${id}`, { as: 'alice', body: { name: 'Hooké 2' } });
    assert.equal(upd.status, 200, 'le hook d\'une modification a échoué : la modification est quand même faite');
    assert.equal(upd.json.name, 'Hooké 2');
    assert.equal((await call('DELETE', `/api/watches/${id}`, { as: 'alice' })).status, 200);
    assert.deepEqual(events, [['créé', 'alice', 'Hooké'], ['supprimé', 70, id]]);
    assert.ok(logged.some((l) => /\[hook onWatchUpdated\]/.test(l)), 'l\'échec du hook est journalisé');
  } finally {
    console.error = origError;
  }
});

test('hooks : onStart / onStop encadrent la vie de l\'application', async () => {
  const seen = [];
  const { app } = await start({ auth: fakeAuth(), hooks: { onStart: () => seen.push('start'), onStop: () => seen.push('stop') }, env: { TELEGRAM_POLL: '0', SURICATE_DEMO: '1' } });
  await app.startBackground();
  await app.stop();
  apps.pop();
  assert.deepEqual(seen, ['start', 'stop']);
});

test('routes : une extension ajoute les siennes (publiques ou non) ; une route déjà déclarée est refusée', async () => {
  const routes = [({ route, app }) => {
    route('GET', '/api/cloud/ping', (ctx) => ({ pong: ctx.account.id, version: app.info.version }), { perm: 'cloud:ping' });
    route('GET', '/api/cloud/plans', () => ({ plans: ['basic', 'pro'] }), { public: true });
  }];
  const { call, app } = await start({ auth: fakeAuth(), routes });
  assert.equal((await call('GET', '/api/cloud/ping')).status, 401);
  assert.equal((await call('GET', '/api/cloud/ping', { as: 'alice' })).json.pong, 70);
  assert.deepEqual((await call('GET', '/api/cloud/plans')).json.plans, ['basic', 'pro']);
  assert.ok(app.routes().some((r) => r.path === '/api/cloud/ping' && r.perm === 'cloud:ping'));

  assert.throws(() => createApp({ auth: fakeAuth(), routes: [({ route }) => route('GET', '/api/watches', () => ({}))] }), /déjà déclarée : GET \/api\/watches/);
  assert.throws(() => createApp({ auth: fakeAuth(), routes: [({ route }) => route('GET', '/api/auth', () => ({}), { public: true })] }), /déjà déclarée/, 'même la route du fournisseur d\'authentification');
});

test('capabilities : fusionnées à celles du cœur', async () => {
  const { call } = await start({ auth: fakeAuth(), capabilities: { mode: 'cloud', billing: true, plans: ['basic'] } });
  const caps = (await call('GET', '/api/capabilities')).json;
  assert.deepEqual({ mode: caps.mode, multiUser: caps.multiUser, billing: caps.billing, plans: caps.plans }, { mode: 'cloud', multiUser: false, billing: true, plans: ['basic'] });
});

test.after(() => dbm.db.close());

// ───────────── Option « home » : page d'accueil à la racine ─────────────

test('home : le visiteur reçoit la page, le compte connecté reçoit l\'application, `vary: cookie` posé', async () => {
  const seen = [];
  const home = async ({ res, identity }) => {
    seen.push(identity?.user?.name ?? null);
    if (identity) return false; // connecté : l'application
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<h1>Accueil visiteur</h1>');
    return true;
  };
  const { call } = await start({ auth: fakeAuth(), home });
  const visitor = await call('GET', '/');
  assert.equal(visitor.status, 200);
  assert.match(visitor.text, /Accueil visiteur/);
  assert.match(visitor.headers.get('vary'), /cookie/i);

  const member = await call('GET', '/', { as: 'alice' });
  assert.equal(member.status, 200);
  assert.match(member.text, /<div id="app">/, 'le compte connecté voit l\'application');
  assert.match(member.headers.get('vary'), /cookie/i, 'la réponse de l\'application varie aussi selon le cookie');
  assert.deepEqual(seen, [null, seen[1]]);
  assert.ok(seen[1], 'le gestionnaire reçoit l\'identité du compte connecté');
});

test('home : appelé pour GET et HEAD « / » seulement ; /index.html reste l\'application', async () => {
  let calls = 0;
  const home = async ({ res }) => { calls++; res.writeHead(200, { 'content-type': 'text/html' }); res.end('accueil'); return true; };
  const { call, base } = await start({ auth: fakeAuth(), home });
  assert.equal((await call('GET', '/index.html')).text.includes('<div id="app">'), true, "/index.html mène à l'application, même sans session");
  assert.equal(calls, 0);
  assert.equal((await call('GET', '/style.css')).status, 200);
  assert.equal(calls, 0, 'les autres chemins ne passent pas par home');
  assert.equal((await fetch(`${base}/`, { method: 'HEAD' })).status, 200);
  assert.equal(calls, 1, 'HEAD « / » passe par home');
  await fetch(`${base}/`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(calls, 1, 'POST « / » ne passe pas par home');
});

test('home : sans l\'option, ou en cas d\'erreur, l\'application est servie', async () => {
  const none = await start({ auth: fakeAuth() });
  assert.match((await none.call('GET', '/')).text, /<div id="app">/);
  assert.equal((await none.call('GET', '/')).headers.get('vary'), null, 'sans home, aucun changement d\'en-têtes');
  await none.app.stop(); apps.pop();

  const boom = await start({ auth: fakeAuth(), home: async () => { throw new Error('panne du gestionnaire'); } });
  assert.match((await boom.call('GET', '/')).text, /<div id="app">/, 'gestionnaire défaillant : application servie');
  await boom.app.stop(); apps.pop();

  const authBoom = { ...fakeAuth(), authenticate: () => { throw new Error('base indisponible'); } };
  let identity = 'jamais appelé';
  const b = await start({ auth: authBoom, home: async ({ identity: i }) => { identity = i; return false; } });
  assert.match((await b.call('GET', '/')).text, /<div id="app">/, 'authentification en panne : application servie');
  assert.equal(identity, null, "une erreur d'authentification n'ouvre rien : le gestionnaire reçoit null");
});
