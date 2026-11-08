// Groupes de sites et organisation (glisser-déposer) : les sites d'un groupe supprimé ne sont jamais supprimés.
import { HttpError } from '../http.js';
import { listGroups, createGroup, updateGroup, deleteGroup, applyLayout } from '../db.js';
import { bus } from '../events.js';

export default function register({ route }) {
  const layoutChanged = () => bus.emit('event', { type: 'layout' });

  route('GET', '/api/groups', async () => listGroups(), { perm: 'group:read' });

  route('POST', '/api/groups', async (ctx) => {
    const g = await createGroup(ctx.body);
    layoutChanged();
    return g;
  }, { perm: 'group:write' });

  route('PUT', '/api/groups/:id', async (ctx) => {
    const g = await updateGroup(Number(ctx.params.id), ctx.body);
    if (!g) throw new HttpError(404, 'Groupe introuvable');
    layoutChanged();
    return g;
  }, { perm: 'group:write' });

  // Les sites du groupe ne sont jamais supprimés : ils passent dans « Sans groupe ».
  route('DELETE', '/api/groups/:id', async (ctx) => {
    if (!await deleteGroup(Number(ctx.params.id))) throw new HttpError(404, 'Groupe introuvable');
    layoutChanged();
    return { ok: true };
  }, { perm: 'group:write' });

  // Organisation complète issue d'un glisser-déposer, appliquée en une seule transaction.
  route('PUT', '/api/layout', async (ctx) => {
    await applyLayout(ctx.body);
    layoutChanged();
    return { ok: true, groups: await listGroups() };
  }, { perm: 'group:write' });

}
