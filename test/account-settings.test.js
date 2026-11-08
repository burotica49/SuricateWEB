// Réglages par compte : chaque compte a SES réglages (Telegram, mots-clés, User-Agent, intervalle, conservation des captures) ;
// l'installation garde les siens (adresse publique, rétention des contrôles, secret de session).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'vigie-acctset-'));
process.env.CHROME_PATH = '/nonexistent/chrome';

// Faux Telegram : enregistre le jeton (dans l'adresse) et la conversation de chaque message.
const sent = [];
const fakeTelegram = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    if (req.url.endsWith('/sendMessage')) sent.push({ token: /\/bot([^/]+)\//.exec(req.url)[1], ...JSON.parse(b) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, result: {} }));
  });
});
await new Promise((r) => fakeTelegram.listen(0, '127.0.0.1', r));
process.env.TELEGRAM_API = `http://127.0.0.1:${fakeTelegram.address().port}`;

// Faux site : enregistre le User-Agent de chaque requête.
const seenUA = [];
let page = '';
const home = (extra = '') => `<!doctype html><html><head><title>Boutique</title></head><body><h1>Bienvenue</h1><p>Artisan depuis 1987.</p><p>Contact</p><p>Mentions légales</p>${extra}</body></html>`;
const site = http.createServer((req, res) => {
  seenUA.push(req.headers['user-agent']);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page);
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const siteUrl = `http://127.0.0.1:${site.address().port}/`;
page = home();

const dbm = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const { isRunning } = await import('../src/scheduler.js');

const A = 10;
const B = 20;
const USERS = { alice: { user: { id: 1, name: 'alice' }, account: { id: A } }, bob: { user: { id: 2, name: 'bob' }, account: { id: B } }, root: { user: { id: 3, name: 'root' }, account: { id: A } } };
const auth = { authenticate: (req) => USERS[req.headers['x-user']] ?? null, register: ({ route }) => route('GET', '/api/auth', () => ({}), { public: true }) };
// « root » seul peut régler l'installation (droit instance:write) : comme un administrateur de la version hébergée.
const authorize = (ctx, action) => action !== 'instance:write' || ctx.user.name === 'root';
const app = createApp({ auth, authorize });
const base = `http://127.0.0.1:${await app.listen(0, '127.0.0.1')}`;

async function call(as, method, path, body) {
  const res = await fetch(base + path, { method, headers: { 'x-user': as, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* pas du JSON */ }
  return { status: res.status, json, text };
}
const settle = async (id) => { for (let i = 0; i < 200 && isRunning(id); i++) await new Promise((r) => setTimeout(r, 25)); };
const NO_NET = { checks: { dns: false, tls: false, rdap: false }, screenshot: { enabled: false } };

test('lecture : un compte sans réglages a les valeurs par défaut ; l\'écriture d\'un compte reste chez lui', async () => {
  const put = await call('alice', 'PUT', '/api/settings', {
    userAgent: 'AgentA/1', defaultInterval: 45, cmsAfterDays: 3, builtinKeywords: ['motalice'],
    telegram: { token: 'A:tok', chatId: '111', enabled: true, minSeverity: 'info', sendScreenshot: false },
  });
  assert.equal(put.status, 200);
  const a = (await call('alice', 'GET', '/api/settings')).json;
  assert.deepEqual([a.userAgent, a.defaultInterval, a.cmsAfterDays, a.builtinKeywords, a.telegram.chatId, a.telegram.tokenSet], ['AgentA/1', 45, 3, ['motalice'], '111', true]);
  const b = (await call('bob', 'GET', '/api/settings')).json;
  assert.deepEqual([b.userAgent, b.defaultInterval, b.cmsAfterDays, b.telegram.chatId, b.telegram.tokenSet], ['Mozilla/5.0 (compatible; VigieWeb/1.0; surveillance de site)', 15, 7, '', false], 'le compte B n\'hérite de rien');
  assert.ok(b.builtinKeywords.includes('hacked by'), 'mots-clés par défaut');
  assert.equal(a.authUser, 'alice');
  assert.ok(!JSON.stringify(a).includes('A:tok'), 'le jeton Telegram n\'est jamais renvoyé');
  // le compte implicite (1) n'est pas touché
  assert.equal(dbm.getSettings().telegram.token, '');
  assert.equal(dbm.getSettings().userAgent, 'Mozilla/5.0 (compatible; VigieWeb/1.0; surveillance de site)');
  await call('bob', 'PUT', '/api/settings', { userAgent: 'AgentB/1', telegram: { token: 'B:tok', chatId: '222', enabled: true, minSeverity: 'info', sendScreenshot: false } });
});

test('l\'intervalle par défaut d\'un site est celui du compte', async () => {
  const sa = (await call('alice', 'POST', '/api/watches', { url: `${siteUrl}?a`, name: 'SiteA', config: NO_NET })).json;
  const sb = (await call('bob', 'POST', '/api/watches', { url: `${siteUrl}?b`, name: 'SiteB', config: NO_NET })).json;
  await settle(sa.id);
  await settle(sb.id);
  assert.equal(sa.interval, 45);
  assert.equal(sb.interval, 15);
});

test('chaque contrôle utilise les réglages du compte de son site : User-Agent, mots-clés, Telegram', async () => {
  assert.ok(seenUA.includes('AgentA/1') && seenUA.includes('AgentB/1'), `User-Agent vus : ${[...new Set(seenUA)].join(' | ')}`);
  const sites = await dbm.listWatches();
  const sa = sites.find((w) => w.name === 'SiteA');
  const sb = sites.find((w) => w.name === 'SiteB');
  sent.length = 0;
  page = home('<p>motalice en promotion</p>');
  const ra = await call('alice', 'POST', `/api/watches/${sa.id}/check`);
  const rb = await call('bob', 'POST', `/api/watches/${sb.id}/check`);
  assert.equal(ra.status, 200);
  assert.equal(rb.status, 200);
  const types = async (id) => (await dbm.db.all('SELECT type FROM alerts WHERE watch_id = ?', [id])).map((r) => r.type).sort();
  assert.ok((await types(sa.id)).includes('forbidden'), 'le mot-clé du compte A est détecté sur son site');
  assert.ok(!(await types(sb.id)).includes('forbidden'), 'le même mot ne l\'est pas sur le site du compte B, qui a d\'autres mots-clés');
  assert.ok((await types(sb.id)).includes('content_changed'));
  // Telegram : chaque message part avec le jeton et vers la conversation de SON compte, jamais l'inverse.
  const forA = sent.filter((m) => m.chat_id === '111');
  const forB = sent.filter((m) => m.chat_id === '222');
  assert.ok(forA.length >= 1 && forB.length >= 1, JSON.stringify(sent.map((m) => [m.chat_id, m.token])));
  assert.ok(forA.every((m) => m.token === 'A:tok' && /SiteA/.test(m.text) && !/SiteB/.test(m.text)));
  assert.ok(forB.every((m) => m.token === 'B:tok' && /SiteB/.test(m.text) && !/SiteA/.test(m.text)));
  assert.equal(sent.length, forA.length + forB.length, 'aucun message vers une autre conversation');
});

test('test d\'envoi et détection Telegram : le jeton enregistré est celui du compte', async () => {
  sent.length = 0;
  const r = await call('bob', 'POST', '/api/telegram/test', {});
  assert.equal(r.status, 200);
  assert.deepEqual([sent[0].token, sent[0].chat_id], ['B:tok', '222']);
});

test('conservation des captures : par compte, et abaisser la limite ne supprime que chez ce compte', async () => {
  const sites = await dbm.listWatches();
  const sa = sites.find((w) => w.name === 'SiteA');
  const sb = sites.find((w) => w.name === 'SiteB');
  for (const w of [sa, sb]) for (let i = 0; i < 5; i++) await dbm.insertScreenshot({ watchId: w.id, ts: Date.now() + i, kind: 'scheduled', file: `${w.id}/${i}.jpg`, size: 10 });
  assert.equal((await call('alice', 'GET', `/api/watches/${sa.id}/screenshots`)).json.keep, 168);
  assert.equal((await call('alice', 'PUT', '/api/settings', { retention: { screenshots: 2 } })).status, 200);
  assert.equal((await dbm.screenshotStats(sa.id)).count, 2, 'le compte A conserve 2 captures');
  assert.equal((await dbm.screenshotStats(sb.id)).count, 5, 'le compte B n\'est pas touché');
  assert.equal((await call('alice', 'GET', `/api/watches/${sa.id}/screenshots`)).json.keep, 2);
  assert.equal((await call('bob', 'GET', `/api/watches/${sb.id}/screenshots`)).json.keep, 168);
});

test('adresse publique : réglage d\'installation, réservé au droit instance:write ; un refus n\'écrit rien du tout', async () => {
  const refused = await call('alice', 'PUT', '/api/settings', { baseUrl: 'https://piratee.example', defaultInterval: 99 });
  assert.deepEqual([refused.status, refused.json.error], [403, 'Accès refusé']);
  assert.equal(dbm.getInstanceSettings().baseUrl, '');
  assert.equal((await call('alice', 'GET', '/api/settings')).json.defaultInterval, 45, 'les autres champs de la même requête ne sont pas appliqués non plus');
  const ok = await call('root', 'PUT', '/api/settings', { baseUrl: 'https://vigie.example/' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.baseUrl, 'https://vigie.example');
  // elle est la même pour tous les comptes
  assert.equal((await call('bob', 'GET', '/api/settings')).json.baseUrl, 'https://vigie.example');
  // les écritures du compte, sans baseUrl, restent permises
  assert.equal((await call('alice', 'PUT', '/api/settings', { defaultInterval: 50 })).status, 200);
});

test('la rétention des contrôles et le secret de session ne sont jamais modifiables par un compte', async () => {
  const before = { ...dbm.getInstanceSettings(), retention: { ...dbm.getInstanceSettings().retention } };
  await call('alice', 'PUT', '/api/settings', { retention: { checks: 1, snapshots: 1 }, sessionSecret: 'vole', settingsVersion: 0 });
  assert.deepEqual(dbm.getInstanceSettings(), before);
});

test.after(async () => {
  await app.stop();
  fakeTelegram.close();
  site.close();
  dbm.db.close();
});
