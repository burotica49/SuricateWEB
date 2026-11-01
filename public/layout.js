// Organisation des sites en groupes : logique PURE (aucun accès au DOM), partagée par l'interface et les tests.
//
// Un « modèle » est la liste ordonnée des sections affichées :
//   [{ gid: 3, ids: [12, 7] }, { gid: 5, ids: [] }, { gid: null, ids: [4, 9] }]
// Les groupes viennent dans leur ordre, puis « Sans groupe » (gid: null), toujours en dernier.
// Toutes les fonctions retournent un NOUVEAU modèle (ou le même objet si rien ne change) : jamais de mutation.

const byPosition = (a, b) => a.position - b.position || String(a.name).localeCompare(String(b.name), 'fr');
const clone = (model) => model.map((s) => ({ gid: s.gid, ids: [...s.ids] }));

/** Construit le modèle à partir des sites ({id, name, groupId, position}) et des groupes ({id, position}). */
export function buildModel(sites, groups) {
  const ordered = [...groups].sort((a, b) => a.position - b.position || a.id - b.id);
  const known = new Set(ordered.map((g) => g.id));
  const idsOf = (pred) => sites.filter(pred).sort(byPosition).map((w) => w.id);
  return [
    ...ordered.map((g) => ({ gid: g.id, ids: idsOf((w) => w.groupId === g.id) })),
    { gid: null, ids: idsOf((w) => w.groupId == null || !known.has(w.groupId)) },
  ];
}

/**
 * Déplace le site `id` dans le groupe `toGid` (null = « Sans groupe »), à la place `index`.
 * `index` est la position d'insertion parmi les sites ACTUELS de la destination, le site déplacé compris
 * (c'est ce que mesure l'interface en survolant une ligne) : on corrige donc le décalage dû au retrait.
 */
export function moveSite(model, id, toGid, index) {
  const m = clone(model);
  const from = m.find((s) => s.ids.includes(id));
  const to = m.find((s) => s.gid === toGid);
  if (!from || !to) return model;
  const at = from.ids.indexOf(id);
  from.ids.splice(at, 1);
  let i = Math.max(0, Math.min(index, to.ids.length + (from === to ? 1 : 0)));
  if (from === to && at < i) i -= 1;
  to.ids.splice(Math.min(i, to.ids.length), 0, id);
  return sameModel(m, model) ? model : m;
}

/** Place le groupe `gid` avant ou après le groupe `targetGid`. « Sans groupe » reste toujours en dernier. */
export function moveGroup(model, gid, targetGid, after) {
  if (gid === targetGid || gid === null) return model;
  const groups = clone(model.filter((s) => s.gid !== null));
  const rest = clone(model.filter((s) => s.gid === null));
  const from = groups.findIndex((s) => s.gid === gid);
  if (from < 0 || !groups.some((s) => s.gid === targetGid)) return model;
  const [g] = groups.splice(from, 1);
  groups.splice(groups.findIndex((s) => s.gid === targetGid) + (after ? 1 : 0), 0, g);
  const m = [...groups, ...rest];
  return sameModel(m, model) ? model : m;
}

/**
 * Pas au clavier : monte (-1) ou descend (+1) d'un cran dans la liste continue de tous les sites. Au bord d'un groupe,
 * le site passe dans le groupe voisin (à la fin du précédent, ou au début du suivant).
 */
export function stepSite(model, id, dir) {
  const m = clone(model);
  const si = m.findIndex((s) => s.ids.includes(id));
  if (si < 0) return model;
  const ids = m[si].ids;
  const i = ids.indexOf(id);
  if (dir < 0) {
    if (i > 0) [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
    else if (si > 0) { ids.splice(i, 1); m[si - 1].ids.push(id); } else return model;
  } else if (i < ids.length - 1) [ids[i + 1], ids[i]] = [ids[i], ids[i + 1]];
  else if (si < m.length - 1) { ids.splice(i, 1); m[si + 1].ids.unshift(id); } else return model;
  return m;
}

/** Pas au clavier pour un groupe : échange avec le groupe voisin (jamais avec « Sans groupe »). */
export function stepGroup(model, gid, dir) {
  const groups = model.filter((s) => s.gid !== null);
  const i = groups.findIndex((s) => s.gid === gid);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= groups.length) return model;
  return moveGroup(model, gid, groups[j].gid, dir > 0);
}

export function sameModel(a, b) {
  return a.length === b.length && a.every((s, i) => s.gid === b[i].gid && s.ids.length === b[i].ids.length && s.ids.every((id, k) => id === b[i].ids[k]));
}

/** Corps de la requête PUT /api/layout. */
export const toPayload = (model) => ({
  groups: model.filter((s) => s.gid !== null).map((s) => s.gid),
  items: model.map((s) => ({ groupId: s.gid, ids: s.ids })),
});

/** Répercute le modèle sur les objets locaux (affichage immédiat, sans attendre le serveur). */
export function applyModel(sites, groups, model) {
  const byId = new Map(sites.map((w) => [w.id, w]));
  for (const sec of model) {
    sec.ids.forEach((id, i) => {
      const w = byId.get(id);
      if (w) Object.assign(w, { groupId: sec.gid, position: i + 1 });
    });
  }
  model.filter((s) => s.gid !== null).forEach((s, i) => {
    const g = groups.find((x) => x.id === s.gid);
    if (g) g.position = i + 1;
  });
}

/** Phrase lue par les lecteurs d'écran après un déplacement. */
export function describeMove(model, kind, id, names) {
  if (kind === 'group') {
    const groups = model.filter((s) => s.gid !== null);
    return `Groupe « ${names.group(id)} » : position ${groups.findIndex((s) => s.gid === id) + 1} sur ${groups.length}.`;
  }
  const sec = model.find((s) => s.ids.includes(id));
  return `« ${names.site(id)} » : position ${sec.ids.indexOf(id) + 1} sur ${sec.ids.length}, ${sec.gid === null ? 'sans groupe' : `groupe « ${names.group(sec.gid)} »`}.`;
}
