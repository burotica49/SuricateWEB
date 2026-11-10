// Accès limité (invité de la version hébergée) : un utilisateur qui n'a accès qu'à certains groupes ou sites du compte A ne voit que ceux-là,
// jamais le reste du compte (ni liste, ni détail, ni alertes, ni flux temps réel), et ne peut rien créer ni réorganiser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'suricate-access-'));
process.env.CHROME_PATH = '/nonexistent/chrome';

const dbm = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const { scopedData } = await import('../src/scoped.js');
const { bus } = await import('../src/events.js');

const A = 10;
const noNet = { checks: { dns: false, tls: false, rdap: false }, screenshot: { enabled: false } };
const g1 = await dbm.createGroup({ name: 'Client Dupont', accountId: A });
const g2 = await dbm.createGroup({ name: 'Client Martin', accountId: A });
const mk = (name, groupId = null) => dbm.createWatch({ name, url: 'https://exemple.invalid/', interval: 60, enabled: false, groupId, accountId: A, config: noNet });
const s1 = await mk('Boutique Dupont', g1.id); // dans le groupe partagé
const s2 = await mk('Site Martin', g2.id); // groupe NON partagé
const s3 = await mk('Blog seul'); // site partagé individuellement
const a1 = await dbm.insertAlert({ watchId: s1.id, severity: 'warning', type: 'content_changed', title: 'alerte 1' });
const a2 = await dbm.insertAlert({ watchId: s2.id, severity: 'warning', type: 'content_changed', title: 'alerte 2' });
const a3 = await dbm.insertAlert({ watchId: s3.id, severity: 'critical', type: 'down', title: 'alerte 3' });
await dbm.saveAccountSettings(A, { telegram: { token: 'SECRET:TOKEN', chatId: '987654' } });

const ACCESS = { groupIds: [g1.id], siteIds: [s3.id] };
const USERS = {
  owner: { user: { id: 1, name: 'owner' }, account: { id: A } },
  ines: { user: { id: 2, name: 'ines' }, account: { id: A }, access: ACCESS },
};
const INVITE_RIGHTS = new Set(['site:read', 'group:read', 'alert:read', 'alert:ack', 'site:ack', 'site:check', 'maintenance:write', 'report:read', 'settings:read']);
const authorize = (ctx, action) => (ctx.user.name === 'owner' ? action !== 'instance:write' : INVITE_RIGHTS.has(action));
const app = createApp({ auth: { authenticate: (req) => USERS[req.headers['x-user']] ?? null, register: ({ route }) => route('GET', '/api/auth', () => ({ authenticated: false }), { public: true }) }, authorize });
const base = `http://127.0.0.1:${await app.listen(0, '127.0.0.1')}`;
test.after(async () => { await app.stop(); dbm.db.close(); });

async function call(as, method, path, body) {
  const res = await fetch(base + path, { method, headers: { 'x-user': as, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* pas du JSON */ }
  return { status: res.status, json, text };
}
const names = (rows) => rows.map((r) => r.name).sort();

test('sites : la liste et le détail ne montrent que le périmètre partagé ; le reste est introuvable (404), comme chez un autre compte', async () => {
  assert.deepEqual(names((await call('owner', 'GET', '/api/watches')).json), ['Blog seul', 'Boutique Dupont', 'Site Martin']);
  assert.deepEqual(names((await call('ines', 'GET', '/api/watches')).json), ['Blog seul', 'Boutique Dupont'], 'groupe partagé + site partagé, pas le site de l\'autre groupe');
  assert.equal((await call('ines', 'GET', `/api/watches/${s1.id}`)).status, 200);
  assert.equal((await call('ines', 'GET', `/api/watches/${s3.id}`)).status, 200);
  assert.equal((await call('ines', 'GET', `/api/watches/${s2.id}`)).status, 404);
  assert.equal((await call('ines', 'GET', `/api/watches/${s2.id}/report`)).status, 404, 'ni rapport');
  assert.equal((await call('ines', 'POST', `/api/watches/${s2.id}/check`)).status, 404, 'ni action sur un site non partagé');
  // Un site ajouté plus tard au groupe partagé devient visible tout seul.
  const later = await mk('Ajouté plus tard', g1.id);
  assert.ok(names((await call('ines', 'GET', '/api/watches')).json).includes('Ajouté plus tard'));
  await dbm.deleteWatch(later.id);
});

test('groupes : seuls ceux du périmètre (ou qui contiennent un site partagé) ; aucune écriture de structure', async () => {
  assert.deepEqual(names((await call('owner', 'GET', '/api/groups')).json), ['Client Dupont', 'Client Martin']);
  assert.deepEqual(names((await call('ines', 'GET', '/api/groups')).json), ['Client Dupont']);
  // Refusé par le droit (authorize) ET par l'accès limité lui-même, même si un droit trop large était accordé.
  assert.equal((await call('ines', 'POST', '/api/watches', { url: 'https://nouveau.example/', name: 'x' })).status, 403);
  assert.equal((await call('ines', 'PUT', `/api/groups/${g1.id}`, { name: 'Piraté' })).status, 403);
  const open = scopedData(A, ACCESS);
  assert.equal(open.restricted, true);
  assert.throws(() => open.createWatch({ name: 'x', url: 'https://x.example/' }), (e) => e.status === 403);
  await assert.rejects(open.updateGroup(g1.id, { name: 'x' }), (e) => e.status === 403);
  await assert.rejects(open.deleteGroup(g1.id), (e) => e.status === 403);
  assert.throws(() => open.applyLayout({}), (e) => e.status === 403);
  assert.equal((await dbm.getGroup(g1.id)).name, 'Client Dupont');
});

test('alertes : liste et acquittement limités au périmètre ; « tout marquer comme lu » ne touche pas le reste du compte', async () => {
  const mine = (await call('ines', 'GET', '/api/alerts')).json;
  assert.deepEqual(mine.map((a) => a.title).sort(), ['alerte 1', 'alerte 3']);
  assert.equal((await call('owner', 'GET', '/api/alerts')).json.length, 3);
  // Marquer une alerte d'un site non partagé : ignoré en silence.
  assert.equal((await call('ines', 'POST', '/api/alerts/read', { ids: [a2] })).status, 200);
  assert.equal((await dbm.queryAlerts({ accountId: A, unread: true })).some((r) => r.id === a2), true, 'l\'alerte du site non partagé reste non lue');
  // Tout marquer comme lu : seulement ses sites.
  await call('ines', 'POST', '/api/alerts/read', { all: true });
  const unread = (await dbm.queryAlerts({ accountId: A, unread: true })).map((r) => r.id);
  assert.deepEqual(unread, [a2], 'seule l\'alerte du site non partagé est encore non lue');
  assert.deepEqual((await call('ines', 'GET', '/api/alerts?unread=1')).json, []);
});

test('tableau de bord et réglages : aucun chiffre ni réglage du reste du compte', async () => {
  const scoped = scopedData(A, ACCESS);
  assert.deepEqual(Object.keys(await scoped.unreadAlertCounts()).map(Number).sort(), [], 'rien de non lu dans le périmètre après l\'acquittement');
  assert.deepEqual(Object.keys(await scoped.sparklines(10)).map(Number).sort((x, y) => x - y), [s1.id, s3.id]);
  assert.deepEqual(Object.keys(await scoped.latestScreenshots()), []);
  assert.deepEqual(await scoped.screenshotUsage(), { count: 0, bytes: 0 });
  assert.equal((await scopedData(A).listWatches()).length, 3, 'sans accès limité : tout le compte, comme avant');

  // La conversation Telegram du titulaire n'est pas montrée à qui ne peut pas modifier les réglages.
  const owner = (await call('owner', 'GET', '/api/settings')).json;
  assert.deepEqual([owner.telegram.chatId, owner.telegram.tokenSet], ['987654', true]);
  const invited = (await call('ines', 'GET', '/api/settings')).json;
  assert.deepEqual([invited.telegram.chatId, invited.telegram.tokenSet, invited.telegram.tokenMasked], ['', false, '']);
  assert.ok(!JSON.stringify(invited).includes('SECRET'));
  assert.equal((await call('ines', 'PUT', '/api/settings', { defaultInterval: 99 })).status, 403);
});

test('flux temps réel : l\'invité ne reçoit pas l\'activité des sites qui ne lui sont pas partagés', async () => {
  const ctl = new AbortController();
  const res = await fetch(`${base}/api/events`, { headers: { 'x-user': 'ines' }, signal: ctl.signal });
  const reader = res.body.getReader();
  let text = '';
  const pump = (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; text += Buffer.from(value).toString(); } } catch { /* fermé */ } })();
  await new Promise((r) => setTimeout(r, 150));
  bus.emit('event', { type: 'check', watchId: s2.id, secret: 'AUTRE-GROUPE' });
  bus.emit('event', { type: 'check', watchId: s1.id, vu: 'PARTAGE' });
  await new Promise((r) => setTimeout(r, 300));
  ctl.abort();
  await pump;
  assert.ok(text.includes('PARTAGE'), 'activité du site partagé reçue');
  assert.ok(!text.includes('AUTRE-GROUPE'), 'rien du site non partagé');
});
