import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Base « d'une ancienne version » : table watches SANS group_id ni position, avec 3 sites déjà là.
const dir = mkdtempSync(join(tmpdir(), 'suricate-groups-'));
process.env.DATA_DIR = dir;
{
  const old = new DatabaseSync(join(dir, 'suricate.db'));
  old.exec(`CREATE TABLE watches (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, url TEXT NOT NULL, interval_min INTEGER NOT NULL DEFAULT 15,
    enabled INTEGER NOT NULL DEFAULT 1, tags TEXT NOT NULL DEFAULT '[]', config TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL, next_run INTEGER NOT NULL DEFAULT 0, last_check INTEGER, last_code INTEGER, last_ms INTEGER, last_error TEXT)`);
  const ins = old.prepare('INSERT INTO watches(name, url, created_at) VALUES(?,?,?)');
  for (const n of ['Charlie', 'Alice', 'Bob']) ins.run(n, `https://${n.toLowerCase()}.test/`, Date.now());
  old.close();
}

const dbm = await import('../src/db.js');
const { GroupError } = dbm;

const mk = async (name, groupId = null) => await dbm.createWatch({ name, url: `https://${name.toLowerCase().replace(/\W+/g, '-')}.test/`, interval: 5, enabled: false, groupId });
/** Organisation lisible : { '∅': [noms], 'Web': [noms] }, groupes dans leur ordre. */
const snapshot = async () => {
  const names = new Map((await dbm.listGroups()).map((g) => [g.id, g.name]));
  const out = {};
  for (const g of await dbm.listGroups()) out[g.name] = [];
  out['∅'] = [];
  for (const w of (await dbm.listWatches()).sort((a, b) => a.position - b.position || a.id - b.id)) (out[names.get(w.groupId) ?? '∅'] ||= []).push(w.name);
  return out;
};
const ids = async (...names) => {
  const all = await dbm.listWatches();
  return names.map((n) => all.find((w) => w.name === n).id);
};

test('migration : les sites existants gardent leur ordre de création, sans groupe', async () => {
  const ws = await dbm.listWatches();
  assert.deepEqual(ws.map((w) => w.name), ['Charlie', 'Alice', 'Bob'], 'ordre de création, pas alphabétique');
  assert.ok(ws.every((w) => w.groupId === null), 'aucun groupe');
  assert.deepEqual(ws.map((w) => w.position), [1, 2, 3]);
});

test('groupes : création, noms nettoyés, doublons refusés, couleur de repli', async () => {
  const a = await dbm.createGroup({ name: '  Clients   web ', color: '#10b981' });
  assert.equal(a.name, 'Clients web', 'espaces normalisés');
  assert.equal(a.color, '#10b981');
  assert.equal(a.collapsed, false);
  assert.equal((await dbm.createGroup({ name: 'Interne', color: 'pas-une-couleur' })).color, dbm.GROUP_COLORS[0], 'couleur invalide → couleur par défaut');
  await assert.rejects(() => dbm.createGroup({ name: 'clients WEB' }), (e) => e instanceof GroupError && e.status === 409, 'doublon sans tenir compte de la casse');
  await assert.rejects(() => dbm.createGroup({ name: '   ' }), (e) => e instanceof GroupError && e.status === 400);
  await assert.rejects(() => dbm.createGroup({ name: 'x'.repeat(41) }), GroupError);
  assert.deepEqual((await dbm.listGroups()).map((g) => g.position), [1, 2]);

  assert.equal((await dbm.updateGroup(a.id, { name: 'Clients web' })).name, 'Clients web', 'renommer en gardant son propre nom est permis');
  await assert.rejects(() => dbm.updateGroup(a.id, { name: 'interne' }), GroupError, 'mais pas de prendre le nom d\'un autre');
  assert.equal((await dbm.updateGroup(a.id, { collapsed: true })).collapsed, true);
  assert.equal(await dbm.updateGroup(999, { name: 'x' }), null);
});

test('un nouveau site est ajouté à la fin de son groupe ; changer de groupe le place à la fin du nouveau', async () => {
  const [clients, interne] = await dbm.listGroups();
  await mk('Delta', clients.id);
  await mk('Echo', clients.id);
  await mk('Foxtrot', interne.id);
  await mk('Golf'); // sans groupe : après Charlie, Alice, Bob
  assert.deepEqual(await snapshot(), { 'Clients web': ['Delta', 'Echo'], Interne: ['Foxtrot'], '∅': ['Charlie', 'Alice', 'Bob', 'Golf'] });

  const [alice] = await ids('Alice');
  await dbm.updateWatch(alice, { groupId: clients.id });
  assert.deepEqual((await snapshot())['Clients web'], ['Delta', 'Echo', 'Alice'], 'arrive en dernier');
  await dbm.updateWatch(alice, { groupId: clients.id, name: 'Alice' });
  assert.deepEqual((await snapshot())['Clients web'], ['Delta', 'Echo', 'Alice'], 'même groupe : le rang ne bouge pas');
  await dbm.updateWatch(alice, { name: 'Alice' }); // groupId absent : inchangé
  assert.equal((await dbm.getWatch(alice)).groupId, clients.id);
  await dbm.updateWatch(alice, { groupId: null });
  assert.deepEqual((await snapshot())['∅'].at(-1), 'Alice', 'retour à « Sans groupe », en dernier');
});

test('réorganisation : groupes, sites, déplacement d\'un groupe à l\'autre', async () => {
  const [clients, interne] = await dbm.listGroups();
  const g = async (n) => (await dbm.listGroups()).find((x) => x.name === n).id;
  assert.deepEqual(await snapshot(), { 'Clients web': ['Delta', 'Echo'], Interne: ['Foxtrot'], '∅': ['Charlie', 'Bob', 'Golf', 'Alice'] });

  await dbm.applyLayout({
    groups: [interne.id, clients.id],
    items: [
      { groupId: interne.id, ids: await ids('Golf', 'Foxtrot') },
      { groupId: clients.id, ids: await ids('Echo', 'Alice', 'Delta') },
      { groupId: null, ids: await ids('Bob', 'Charlie') },
    ],
  });
  assert.deepEqual((await dbm.listGroups()).map((x) => x.name), ['Interne', 'Clients web'], 'groupes réordonnés');
  assert.deepEqual(await snapshot(), { Interne: ['Golf', 'Foxtrot'], 'Clients web': ['Echo', 'Alice', 'Delta'], '∅': ['Bob', 'Charlie'] });
  const clientsId = await g('Clients web');
  assert.deepEqual((await dbm.listWatches()).filter((w) => w.groupId === clientsId).map((w) => w.position).sort(), [1, 2, 3], 'rangs consécutifs');
});

test('réorganisation partielle : les groupes et sites non cités gardent leur place relative', async () => {
  await dbm.createGroup({ name: 'Archives' });
  const [interne, clients, archives] = await dbm.listGroups();
  await dbm.applyLayout({ groups: [archives.id], items: [{ groupId: archives.id, ids: await ids('Bob') }] });
  assert.deepEqual((await dbm.listGroups()).map((x) => x.name), ['Archives', 'Interne', 'Clients web'], 'cité en premier, les autres suivent dans l\'ordre');
  assert.deepEqual((await snapshot()).Archives, ['Bob']);
  assert.deepEqual((await snapshot())['Clients web'], ['Echo', 'Alice', 'Delta'], 'non cité : inchangé');
  void interne; void clients;
});

test('réorganisation invalide : refusée EN ENTIER, rien n\'est modifié', async () => {
  const before = JSON.stringify([await dbm.listGroups(), (await dbm.listWatches()).map((w) => [w.id, w.groupId, w.position])]);
  const [g1] = await dbm.listGroups();
  const [a, b] = await ids('Alice', 'Bob');
  const bad = [
    [{ groups: [9999], items: [] }, /Groupe inconnu/],
    [{ groups: [g1.id, g1.id], items: [] }, /en double/],
    [{ groups: [], items: [{ groupId: 9999, ids: [a] }] }, /Groupe inconnu/],
    [{ groups: [], items: [{ groupId: null, ids: [a, 9999] }] }, /Site inconnu/],
    [{ groups: [], items: [{ groupId: g1.id, ids: [a] }, { groupId: null, ids: [a, b] }] }, /Site en double/], // 1re liste valide, 2e invalide
    [{ groups: 'x', items: [] }, /invalide/],
    [{ groups: [], items: [{ groupId: null, ids: 'x' }] }, /invalide/],
  ];
  for (const [payload, re] of bad) await assert.rejects(() => dbm.applyLayout(payload), (e) => e instanceof GroupError && re.test(e.message), JSON.stringify(payload));
  assert.equal(JSON.stringify([await dbm.listGroups(), (await dbm.listWatches()).map((w) => [w.id, w.groupId, w.position])]), before, 'état strictement identique');
});

test('suppression d\'un groupe : ses sites ne sont JAMAIS supprimés, ils passent « Sans groupe », dans leur ordre', async () => {
  const total = (await dbm.listWatches()).length;
  const clients = (await dbm.listGroups()).find((g) => g.name === 'Clients web');
  const members = (await snapshot())['Clients web'];
  const ungroupedBefore = (await snapshot())['∅'];
  assert.equal(await dbm.deleteGroup(clients.id), true);
  assert.equal((await dbm.listWatches()).length, total, 'aucun site supprimé');
  assert.deepEqual((await snapshot())['∅'], [...ungroupedBefore, ...members], 'à la fin de « Sans groupe », ordre conservé');
  assert.equal(await dbm.getGroup(clients.id), null);
  assert.deepEqual((await dbm.listGroups()).map((g) => g.position), [1, 2], 'rangs des groupes renumérotés');
  assert.equal(await dbm.deleteGroup(clients.id), false, 'déjà supprimé');
});

test('suppression d\'un site : l\'ordre des autres n\'est pas perturbé', async () => {
  const before = (await snapshot())['∅'];
  await dbm.deleteWatch((await ids('Charlie'))[0]);
  assert.deepEqual((await snapshot())['∅'], before.filter((n) => n !== 'Charlie'));
  await mk('Hotel');
  assert.equal((await snapshot())['∅'].at(-1), 'Hotel');
});

test.after(() => dbm.db.close());
