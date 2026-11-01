import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../test-support/server.js';

const srv = await startServer();
test.after(() => srv.stop());

// Sites désactivés : aucun contrôle réseau pendant ces tests.
const site = async (name, extra = {}) => {
  const r = await srv.post('/api/watches', { url: `https://${name.toLowerCase()}.test/`, name, enabled: false, ...extra });
  assert.equal(r.status, 200, r.text);
  return r.json;
};
const groupNamed = async (name) => (await srv.get('/api/groups')).json.find((g) => g.name === name);
/** { 'Groupe': [noms], '∅': [noms] } à partir de l'API, dans l'ordre d'affichage. */
const organisation = async () => {
  const groups = (await srv.get('/api/groups')).json;
  const watches = (await srv.get('/api/watches')).json.sort((a, b) => a.position - b.position || a.id - b.id);
  const out = Object.fromEntries([...groups.map((g) => [g.name, []]), ['∅', []]]);
  for (const w of watches) out[groups.find((g) => g.id === w.groupId)?.name ?? '∅'].push(w.name);
  return out;
};

test('les routes de groupes exigent la connexion', async () => {
  srv.logout();
  for (const [m, p] of [['GET', '/api/groups'], ['POST', '/api/groups'], ['PUT', '/api/groups/1'], ['DELETE', '/api/groups/1'], ['PUT', '/api/layout']]) {
    assert.equal((await srv.call(m, p, m === 'GET' || m === 'DELETE' ? undefined : {})).status, 401, `${m} ${p}`);
  }
  assert.equal(await srv.login(), 200);
});

test('créer, renommer, replier, valider', async () => {
  const web = await srv.post('/api/groups', { name: ' Clients  web ', color: '#10b981' });
  assert.equal(web.status, 200);
  assert.deepEqual([web.json.name, web.json.color, web.json.collapsed], ['Clients web', '#10b981', false]);

  assert.equal((await srv.post('/api/groups', { name: 'CLIENTS WEB' })).status, 409, 'doublon');
  assert.equal((await srv.post('/api/groups', { name: '' })).status, 400);
  assert.equal((await srv.post('/api/groups', {})).status, 400);
  assert.match((await srv.post('/api/groups', { name: '' })).json.error, /obligatoire/);

  await srv.post('/api/groups', { name: 'Interne' });
  const renamed = await srv.put(`/api/groups/${web.json.id}`, { name: 'Clients', collapsed: true });
  assert.deepEqual([renamed.json.name, renamed.json.collapsed], ['Clients', true]);
  assert.equal((await srv.put(`/api/groups/${web.json.id}`, { name: 'interne' })).status, 409);
  assert.equal((await srv.put('/api/groups/9999', { name: 'x' })).status, 404);
  assert.deepEqual((await srv.get('/api/groups')).json.map((g) => g.name), ['Clients', 'Interne']);
  await srv.put(`/api/groups/${web.json.id}`, { collapsed: false });
});

test('un site se crée dans un groupe, change de groupe, et un groupe inconnu est refusé', async () => {
  const clients = await groupNamed('Clients');
  const interne = await groupNamed('Interne');
  const a = await site('Alpha', { groupId: clients.id });
  const b = await site('Bravo', { groupId: clients.id });
  const c = await site('Charlie', { groupId: interne.id });
  await site('Delta');
  assert.equal(a.groupId, clients.id);
  assert.deepEqual(await organisation(), { Clients: ['Alpha', 'Bravo'], Interne: ['Charlie'], '∅': ['Delta'] });

  assert.equal((await srv.post('/api/watches', { url: 'https://x.test/', groupId: 9999 })).status, 400, 'groupe inconnu à la création');
  assert.equal((await srv.put(`/api/watches/${a.id}`, { groupId: 9999 })).status, 400, 'groupe inconnu à la modification');

  assert.equal((await srv.put(`/api/watches/${a.id}`, { name: 'Alpha renommé' })).json.groupId, clients.id, 'sans groupId : inchangé');
  assert.equal((await srv.put(`/api/watches/${a.id}`, { name: 'Alpha', groupId: interne.id })).json.groupId, interne.id);
  assert.deepEqual(await organisation(), { Clients: ['Bravo'], Interne: ['Charlie', 'Alpha'], '∅': ['Delta'] }, 'arrive en dernier');
  assert.equal((await srv.put(`/api/watches/${a.id}`, { groupId: null })).json.groupId, null);
  assert.deepEqual(await organisation(), { Clients: ['Bravo'], Interne: ['Charlie'], '∅': ['Delta', 'Alpha'] });
  void b; void c;
});

test('PUT /api/layout : organisation complète, atomique', async () => {
  const clients = await groupNamed('Clients');
  const interne = await groupNamed('Interne');
  const all = (await srv.get('/api/watches')).json;
  const id = (n) => all.find((w) => w.name === n).id;

  const ok = await srv.put('/api/layout', {
    groups: [interne.id, clients.id],
    items: [
      { groupId: interne.id, ids: [id('Delta'), id('Charlie')] },
      { groupId: clients.id, ids: [id('Alpha'), id('Bravo')] },
      { groupId: null, ids: [] },
    ],
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.groups.map((g) => g.name), ['Interne', 'Clients']);
  assert.deepEqual(await organisation(), { Interne: ['Delta', 'Charlie'], Clients: ['Alpha', 'Bravo'], '∅': [] });

  const before = JSON.stringify(await organisation());
  for (const bad of [
    { groups: [9999], items: [] },
    { groups: [], items: [{ groupId: null, ids: [id('Alpha'), 424242] }] },
    { groups: [], items: [{ groupId: clients.id, ids: [id('Alpha')] }, { groupId: null, ids: [id('Alpha')] }] },
    { groups: 'nope', items: [] },
  ]) {
    const r = await srv.put('/api/layout', bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.ok(r.json.error);
  }
  assert.equal(JSON.stringify(await organisation()), before, 'une demande invalide ne change rien');
});

test('supprimer un groupe : ses sites passent « Sans groupe », rien n\'est supprimé', async () => {
  const total = (await srv.get('/api/watches')).json.length;
  const clients = await groupNamed('Clients');
  assert.equal((await srv.del(`/api/groups/${clients.id}`)).status, 200);
  assert.equal((await srv.get('/api/watches')).json.length, total);
  assert.deepEqual(await organisation(), { Interne: ['Delta', 'Charlie'], '∅': ['Alpha', 'Bravo'] });
  assert.equal((await srv.del(`/api/groups/${clients.id}`)).status, 404);
});

test('export puis import dans une autre installation : groupes recréés par leur nom, ordre conservé', async () => {
  const exp = await srv.get('/api/export');
  assert.equal(exp.status, 200);
  assert.deepEqual(exp.json.groups.map((g) => g.name), ['Interne']);
  assert.deepEqual(exp.json.watches.map((w) => [w.name, w.group]).sort(), [['Alpha', null], ['Bravo', null], ['Charlie', 'Interne'], ['Delta', 'Interne']]);
  assert.ok(exp.json.watches.every((w) => !('groupId' in w)), 'les identifiants internes ne sont pas exportés');

  const other = await startServer();
  try {
    // Un groupe de même nom (casse différente) existe déjà : il doit être réutilisé, pas dupliqué.
    const pre = (await other.post('/api/groups', { name: 'INTERNE', color: '#ef4444' })).json;
    const imp = await other.post('/api/import', exp.json);
    assert.deepEqual(imp.json, { added: 4, skipped: 0 });
    const groups = (await other.get('/api/groups')).json;
    assert.deepEqual(groups.map((g) => g.name), ['INTERNE'], 'réutilisé, pas dupliqué');
    const ws = (await other.get('/api/watches')).json.sort((a, b) => a.position - b.position || a.id - b.id);
    assert.deepEqual(ws.filter((w) => w.groupId === pre.id).map((w) => w.name), ['Delta', 'Charlie'], 'ordre conservé dans le groupe');
    assert.deepEqual(ws.filter((w) => w.groupId === null).map((w) => w.name), ['Alpha', 'Bravo']);

    // Réimporter ne duplique rien
    assert.deepEqual((await other.post('/api/import', exp.json)).json, { added: 0, skipped: 4 });
  } finally {
    await other.stop();
  }

  // Import d'un ancien export (version 1, sans groupes) : tout se passe comme avant.
  const third = await startServer();
  try {
    const old = { version: 1, watches: exp.json.watches.map(({ group, ...w }) => w) };
    assert.deepEqual((await third.post('/api/import', old)).json, { added: 4, skipped: 0 });
    assert.deepEqual((await third.get('/api/groups')).json, []);
  } finally {
    await third.stop();
  }

  // Un groupe importé avec un nom invalide n'empêche pas l'import du site.
  const fourth = await startServer();
  try {
    const bad = { watches: [{ name: 'Zulu', url: 'https://zulu.test/', group: 'x'.repeat(60) }] };
    assert.deepEqual((await fourth.post('/api/import', bad)).json, { added: 1, skipped: 0 });
    assert.equal((await fourth.get('/api/watches')).json[0].groupId, null);
  } finally {
    await fourth.stop();
  }
});
