// Groupes de sites et organisation (glisser-déposer) : les sites d'un groupe supprimé ne sont jamais supprimés.
import { HttpError } from '../http.js';
import { bus } from '../events.js';

export default function register({ route }) {
  const layoutChanged = () => bus.emit('event', { type: 'layout' });

  route('GET', '/api/groups', async (ctx) => ctx.data.listGroups(), { perm: 'group:read' });

  route('POST', '/api/groups', async (ctx) => {
    const g = await ctx.data.createGroup(ctx.body);
    layoutChanged();
    return g;
  }, { perm: 'group:write' });

  route('PUT', '/api/groups/:id', async (ctx) => {
    const g = await ctx.data.updateGroup(Number(ctx.params.id), ctx.body);
    if (!g) throw new HttpError(404, 'Groupe introuvable');
    layoutChanged();
    return g;
  }, { perm: 'group:write' });

  // Les sites du groupe ne sont jamais supprimés : ils passent dans « Sans groupe ».
  route('DELETE', '/api/groups/:id', async (ctx) => {
    if (!await ctx.data.deleteGroup(Number(ctx.params.id))) throw new HttpError(404, 'Groupe introuvable');
    layoutChanged();
    return { ok: true };
  }, { perm: 'group:write' });

  // Organisation complète issue d'un glisser-déposer, appliquée en une seule transaction.
  route('PUT', '/api/layout', async (ctx) => {
    await ctx.data.applyLayout(ctx.body);
    layoutChanged();
    return { ok: true, groups: await ctx.data.listGroups() };
  }, { perm: 'group:write' });

}
