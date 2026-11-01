import test from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, moveSite, moveGroup, stepSite, stepGroup, sameModel, toPayload, applyModel, describeMove } from '../public/layout.js';

const W = (id, name, groupId, position) => ({ id, name, groupId, position });
const sites = [W(1, 'Alpha', 10, 1), W(2, 'Bravo', 10, 2), W(3, 'Charlie', 10, 3), W(4, 'Delta', 20, 1), W(5, 'Echo', null, 1), W(6, 'Foxtrot', null, 2)];
const groups = [{ id: 20, position: 2 }, { id: 10, position: 1 }, { id: 30, position: 3 }]; // volontairement désordonnés
const base = () => buildModel(sites, groups);
const flat = (m) => m.map((s) => `${s.gid ?? '∅'}:${s.ids.join(',')}`).join(' | ');

test('buildModel : groupes par position, vides compris, « Sans groupe » en dernier ; sites par rang', () => {
  assert.equal(flat(base()), '10:1,2,3 | 20:4 | 30: | ∅:5,6');
  // un site dont le groupe n'existe plus (incohérence) retombe dans « Sans groupe » au lieu de disparaître
  // (à rang égal avec Echo, l'ordre alphabétique départage : Echo avant Golf)
  assert.equal(flat(buildModel([...sites, W(7, 'Golf', 999, 1)], groups)), '10:1,2,3 | 20:4 | 30: | ∅:5,7,6');
  // rangs égaux : ordre alphabétique, stable
  assert.equal(flat(buildModel([W(1, 'zèbre', null, 1), W(2, 'Abeille', null, 1)], [])), '∅:2,1');
});

test('moveSite : dans le même groupe (l\'index est mesuré AVANT le retrait)', () => {
  assert.equal(flat(moveSite(base(), 1, 10, 3)), '10:2,3,1 | 20:4 | 30: | ∅:5,6', 'Alpha avant Charlie+1 → après Charlie');
  assert.equal(flat(moveSite(base(), 1, 10, 2)), '10:2,1,3 | 20:4 | 30: | ∅:5,6', 'entre Bravo et Charlie');
  assert.equal(flat(moveSite(base(), 3, 10, 0)), '10:3,1,2 | 20:4 | 30: | ∅:5,6', 'en tête');
  assert.equal(flat(moveSite(base(), 2, 10, 3)), '10:1,3,2 | 20:4 | 30: | ∅:5,6');
});

test('moveSite : sans effet quand le site reste où il est (le même objet est renvoyé)', () => {
  const m = base();
  assert.equal(moveSite(m, 2, 10, 1), m, 'juste avant lui-même');
  assert.equal(moveSite(m, 2, 10, 2), m, 'juste après lui-même');
  assert.equal(moveSite(m, 3, 10, 3), m, 'à la fin, déjà dernier');
  assert.equal(moveSite(m, 999, 10, 0), m, 'site inconnu');
  assert.equal(moveSite(m, 1, 777, 0), m, 'groupe inconnu');
});

test('moveSite : vers un autre groupe, un groupe vide, ou « Sans groupe »', () => {
  assert.equal(flat(moveSite(base(), 2, 20, 0)), '10:1,3 | 20:2,4 | 30: | ∅:5,6');
  assert.equal(flat(moveSite(base(), 2, 20, 1)), '10:1,3 | 20:4,2 | 30: | ∅:5,6');
  assert.equal(flat(moveSite(base(), 4, 30, 0)), '10:1,2,3 | 20: | 30:4 | ∅:5,6', 'vers un groupe vide');
  assert.equal(flat(moveSite(base(), 1, null, 1)), '10:2,3 | 20:4 | 30: | ∅:5,1,6', 'vers « Sans groupe »');
  assert.equal(flat(moveSite(base(), 5, 10, 99)), '10:1,2,3,5 | 20:4 | 30: | ∅:6', 'index trop grand : à la fin');
  assert.equal(flat(moveSite(base(), 5, 10, -5)), '10:5,1,2,3 | 20:4 | 30: | ∅:6', 'index négatif : au début');
});

test('moveGroup : avant / après, et « Sans groupe » reste en dernier', () => {
  assert.equal(flat(moveGroup(base(), 30, 10, false)), '30: | 10:1,2,3 | 20:4 | ∅:5,6');
  assert.equal(flat(moveGroup(base(), 10, 20, true)), '20:4 | 10:1,2,3 | 30: | ∅:5,6');
  assert.equal(flat(moveGroup(base(), 10, 30, true)), '20:4 | 30: | 10:1,2,3 | ∅:5,6', 'à la fin des groupes, avant « Sans groupe »');
  const m = base();
  assert.equal(moveGroup(m, 10, 10, true), m, 'sur lui-même');
  assert.equal(moveGroup(m, 10, 20, false), m, 'déjà juste avant');
  assert.equal(moveGroup(m, null, 10, true), m, '« Sans groupe » ne se déplace pas');
  assert.equal(moveGroup(m, 10, 999, true), m);
  assert.equal(base().at(-1).gid, null);
});

test('stepSite (clavier) : parcourt la liste continue et franchit les frontières de groupes', () => {
  assert.equal(flat(stepSite(base(), 2, -1)), '10:2,1,3 | 20:4 | 30: | ∅:5,6', 'monter dans le groupe');
  assert.equal(flat(stepSite(base(), 2, +1)), '10:1,3,2 | 20:4 | 30: | ∅:5,6');
  assert.equal(flat(stepSite(base(), 3, +1)), '10:1,2 | 20:3,4 | 30: | ∅:5,6', 'en bas d\'un groupe → début du suivant');
  assert.equal(flat(stepSite(base(), 4, -1)), '10:1,2,3,4 | 20: | 30: | ∅:5,6', 'en haut d\'un groupe → fin du précédent');
  assert.equal(flat(stepSite(base(), 4, +1)), '10:1,2,3 | 20: | 30:4 | ∅:5,6', 'vers un groupe vide');
  assert.equal(flat(stepSite(base(), 5, -1)), '10:1,2,3 | 20:4 | 30:5 | ∅:6', '« Sans groupe » → fin du dernier groupe');
  const m = base();
  assert.equal(stepSite(m, 1, -1), m, 'tout en haut : rien');
  assert.equal(stepSite(m, 6, +1), m, 'tout en bas : rien');
  // monter 6 fois depuis le bas traverse toute la liste sans perdre ni dupliquer de site
  let cur = base();
  const seen = [];
  for (let i = 0; i < 12; i++) { cur = stepSite(cur, 6, -1); seen.push(cur.flatMap((s) => s.ids).sort().join()); }
  assert.ok(seen.every((s) => s === '1,2,3,4,5,6'), 'aucun site perdu ni dupliqué');
  assert.equal(flat(cur).startsWith('10:6,1,2,3'), true);
});

test('stepGroup (clavier) : échange avec le voisin, jamais avec « Sans groupe »', () => {
  assert.equal(flat(stepGroup(base(), 10, +1)), '20:4 | 10:1,2,3 | 30: | ∅:5,6');
  assert.equal(flat(stepGroup(base(), 30, -1)), '10:1,2,3 | 30: | 20:4 | ∅:5,6');
  const m = base();
  assert.equal(stepGroup(m, 10, -1), m, 'déjà premier');
  assert.equal(stepGroup(m, 30, +1), m, 'déjà dernier : ne passe pas après « Sans groupe »');
});

test('toPayload / applyModel : aller-retour avec les objets locaux', () => {
  const m = moveSite(moveGroup(base(), 30, 10, false), 5, 30, 0);
  assert.deepEqual(toPayload(m), { groups: [30, 10, 20], items: [{ groupId: 30, ids: [5] }, { groupId: 10, ids: [1, 2, 3] }, { groupId: 20, ids: [4] }, { groupId: null, ids: [6] }] });

  const s = sites.map((w) => ({ ...w })), g = groups.map((x) => ({ ...x }));
  applyModel(s, g, m);
  assert.equal(flat(buildModel(s, g)), flat(m), 'reconstruire depuis les objets mis à jour redonne le même modèle');
  assert.deepEqual(s.find((w) => w.id === 5), { id: 5, name: 'Echo', groupId: 30, position: 1 });
});

test('sameModel et describeMove', () => {
  assert.equal(sameModel(base(), base()), true);
  assert.equal(sameModel(base(), moveSite(base(), 1, 10, 3)), false);
  const names = { site: (id) => sites.find((w) => w.id === id).name, group: (id) => `G${id}` };
  assert.equal(describeMove(base(), 'site', 2, names), '« Bravo » : position 2 sur 3, groupe « G10 ».');
  assert.equal(describeMove(base(), 'site', 6, names), '« Foxtrot » : position 2 sur 2, sans groupe.');
  assert.equal(describeMove(base(), 'group', 20, names), 'Groupe « G20 » : position 2 sur 3.');
});

test('le modèle d\'origine n\'est jamais modifié (pas de mutation)', () => {
  const m = base();
  const snapshot = JSON.stringify(m);
  moveSite(m, 1, 20, 0); moveGroup(m, 10, 30, true); stepSite(m, 3, 1); stepGroup(m, 10, 1);
  assert.equal(JSON.stringify(m), snapshot);
});
