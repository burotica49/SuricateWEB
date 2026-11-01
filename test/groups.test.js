import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Base « d'une ancienne version » : table watches SANS group_id ni position, avec 3 sites déjà là.
const dir = mkdtempSync(join(tmpdir(), 'vigie-groups-'));
process.env.DATA_DIR = dir;
{
  const old = new DatabaseSync(join(dir, 'vigie.db'));
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

const mk = (name, groupId = null) => dbm.createWatch({ name, url: `https://${name.toLowerCase().replace(/\W+/g, '-')}.test/`, interval: 5, enabled: false, groupId });
/** Organisation lisible : { '∅': [noms], 'Web': [noms] }, groupes dans leur ordre. */
const snapshot = () => {
  const names = new Map(dbm.listGroups().map((g) => [g.id, g.name]));
  const out = {};
  for (const g of dbm.listGroups()) out[g.name] = [];
  out['∅'] = [];
  for (const w of dbm.listWatches().sort((a, b) => a.position - b.position || a.id - b.id)) (out[names.get(w.groupId) ?? '∅'] ||= []).push(w.name);
  return out;
};
const ids = (...names) => names.map((n) => dbm.listWatches().find((w) => w.name === n).id);

test('migration : les sites existants gardent leur ordre de création, sans groupe', () => {
  const ws = dbm.listWatches();
  assert.deepEqual(ws.map((w) => w.name), ['Charlie', 'Alice', 'Bob'], 'ordre de création, pas alphabétique');
  assert.ok(ws.every((w) => w.groupId === null), 'aucun groupe');
  assert.deepEqual(ws.map((w) => w.position), [1, 2, 3]);
});

test('groupes : création, noms nettoyés, doublons refusés, couleur de repli', () => {
  const a = dbm.createGroup({ name: '  Clients   web ', color: '#10b981' });
  assert.equal(a.name, 'Clients web', 'espaces normalisés');
  assert.equal(a.color, '#10b981');
  assert.equal(a.collapsed, false);
  assert.equal(dbm.createGroup({ name: 'Interne', color: 'pas-une-couleur' }).color, dbm.GROUP_COLORS[0], 'couleur invalide → couleur par défaut');
  assert.throws(() => dbm.createGroup({ name: 'clients WEB' }), (e) => e instanceof GroupError && e.status === 409, 'doublon sans tenir compte de la casse');
  assert.throws(() => dbm.createGroup({ name: '   ' }), (e) => e instanceof GroupError && e.status === 400);
  assert.throws(() => dbm.createGroup({ name: 'x'.repeat(41) }), GroupError);
  assert.deepEqual(dbm.listGroups().map((g) => g.position), [1, 2]);

  assert.equal(dbm.updateGroup(a.id, { name: 'Clients web' }).name, 'Clients web', 'renommer en gardant son propre nom est permis');
  assert.throws(() => dbm.updateGroup(a.id, { name: 'interne' }), GroupError, 'mais pas de prendre le nom d\'un autre');
  assert.equal(dbm.updateGroup(a.id, { collapsed: true }).collapsed, true);
  assert.equal(dbm.updateGroup(999, { name: 'x' }), null);
});

test('un nouveau site est ajouté à la fin de son groupe ; changer de groupe le place à la fin du nouveau', () => {
  const [clients, interne] = dbm.listGroups();
  mk('Delta', clients.id);
  mk('Echo', clients.id);
  mk('Foxtrot', interne.id);
  mk('Golf'); // sans groupe : après Charlie, Alice, Bob
  assert.deepEqual(snapshot(), { 'Clients web': ['Delta', 'Echo'], Interne: ['Foxtrot'], '∅': ['Charlie', 'Alice', 'Bob', 'Golf'] });

  const [alice] = ids('Alice');
  dbm.updateWatch(alice, { groupId: clients.id });
  assert.deepEqual(snapshot()['Clients web'], ['Delta', 'Echo', 'Alice'], 'arrive en dernier');
  dbm.updateWatch(alice, { groupId: clients.id, name: 'Alice' });
  assert.deepEqual(snapshot()['Clients web'], ['Delta', 'Echo', 'Alice'], 'même groupe : le rang ne bouge pas');
  dbm.updateWatch(alice, { name: 'Alice' }); // groupId absent : inchangé
  assert.equal(dbm.getWatch(alice).groupId, clients.id);
  dbm.updateWatch(alice, { groupId: null });
  assert.deepEqual(snapshot()['∅'].at(-1), 'Alice', 'retour à « Sans groupe », en dernier');
});

test('réorganisation : groupes, sites, déplacement d\'un groupe à l\'autre', () => {
  const [clients, interne] = dbm.listGroups();
  const g = (n) => dbm.listGroups().find((x) => x.name === n).id;
  assert.deepEqual(snapshot(), { 'Clients web': ['Delta', 'Echo'], Interne: ['Foxtrot'], '∅': ['Charlie', 'Bob', 'Golf', 'Alice'] });

  dbm.applyLayout({
    groups: [interne.id, clients.id],
    items: [
      { groupId: interne.id, ids: ids('Golf', 'Foxtrot') },
      { groupId: clients.id, ids: ids('Echo', 'Alice', 'Delta') },
      { groupId: null, ids: ids('Bob', 'Charlie') },
    ],
  });
  assert.deepEqual(dbm.listGroups().map((x) => x.name), ['Interne', 'Clients web'], 'groupes réordonnés');
  assert.deepEqual(snapshot(), { Interne: ['Golf', 'Foxtrot'], 'Clients web': ['Echo', 'Alice', 'Delta'], '∅': ['Bob', 'Charlie'] });
  assert.deepEqual(dbm.listWatches().filter((w) => w.groupId === g('Clients web')).map((w) => w.position).sort(), [1, 2, 3], 'rangs consécutifs');
});

test('réorganisation partielle : les groupes et sites non cités gardent leur place relative', () => {
  dbm.createGroup({ name: 'Archives' });
  const [interne, clients, archives] = dbm.listGroups();
  dbm.applyLayout({ groups: [archives.id], items: [{ groupId: archives.id, ids: ids('Bob') }] });
  assert.deepEqual(dbm.listGroups().map((x) => x.name), ['Archives', 'Interne', 'Clients web'], 'cité en premier, les autres suivent dans l\'ordre');
  assert.deepEqual(snapshot().Archives, ['Bob']);
  assert.deepEqual(snapshot()['Clients web'], ['Echo', 'Alice', 'Delta'], 'non cité : inchangé');
  void interne; void clients;
});

test('réorganisation invalide : refusée EN ENTIER, rien n\'est modifié', () => {
  const before = JSON.stringify([dbm.listGroups(), dbm.listWatches().map((w) => [w.id, w.groupId, w.position])]);
  const [g1] = dbm.listGroups();
  const [a, b] = ids('Alice', 'Bob');
  const bad = [
    [{ groups: [9999], items: [] }, /Groupe inconnu/],
    [{ groups: [g1.id, g1.id], items: [] }, /en double/],
    [{ groups: [], items: [{ groupId: 9999, ids: [a] }] }, /Groupe inconnu/],
    [{ groups: [], items: [{ groupId: null, ids: [a, 9999] }] }, /Site inconnu/],
    [{ groups: [], items: [{ groupId: g1.id, ids: [a] }, { groupId: null, ids: [a, b] }] }, /Site en double/], // 1re liste valide, 2e invalide
    [{ groups: 'x', items: [] }, /invalide/],
    [{ groups: [], items: [{ groupId: null, ids: 'x' }] }, /invalide/],
  ];
  for (const [payload, re] of bad) assert.throws(() => dbm.applyLayout(payload), (e) => e instanceof GroupError && re.test(e.message), JSON.stringify(payload));
  assert.equal(JSON.stringify([dbm.listGroups(), dbm.listWatches().map((w) => [w.id, w.groupId, w.position])]), before, 'état strictement identique');
});

test('suppression d\'un groupe : ses sites ne sont JAMAIS supprimés, ils passent « Sans groupe », dans leur ordre', () => {
  const total = dbm.listWatches().length;
  const clients = dbm.listGroups().find((g) => g.name === 'Clients web');
  const members = snapshot()['Clients web'];
  const ungroupedBefore = snapshot()['∅'];
  assert.equal(dbm.deleteGroup(clients.id), true);
  assert.equal(dbm.listWatches().length, total, 'aucun site supprimé');
  assert.deepEqual(snapshot()['∅'], [...ungroupedBefore, ...members], 'à la fin de « Sans groupe », ordre conservé');
  assert.equal(dbm.getGroup(clients.id), null);
  assert.deepEqual(dbm.listGroups().map((g) => g.position), [1, 2], 'rangs des groupes renumérotés');
  assert.equal(dbm.deleteGroup(clients.id), false, 'déjà supprimé');
});

test('suppression d\'un site : l\'ordre des autres n\'est pas perturbé', () => {
  const before = snapshot()['∅'];
  dbm.deleteWatch(ids('Charlie')[0]);
  assert.deepEqual(snapshot()['∅'], before.filter((n) => n !== 'Charlie'));
  mk('Hotel');
  assert.equal(snapshot()['∅'].at(-1), 'Hotel');
});

test.after(() => dbm.db.close());
