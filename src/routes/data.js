// Export et import des sites (groupes recréés par leur nom).
import { enqueue } from '../scheduler.js';
import { watchInput } from './shared.js';

export default function register({ route }) {
  route('GET', '/api/export', async (ctx) => {
    ctx.headers['content-disposition'] = 'attachment; filename="suricate-sites.json"';
    const groups = await ctx.data.listGroups();
    const nameOf = new Map(groups.map((g) => [g.id, g.name]));
    return {
      version: 2,
      groups: groups.map((g) => ({ name: g.name, color: g.color, collapsed: g.collapsed })),
      // Les identifiants de groupe sont propres à chaque installation : on exporte le NOM du groupe.
      watches: (await ctx.data.listWatches()).map((w) => ({ name: w.name, url: w.url, interval: w.interval, tags: w.tags, enabled: w.enabled, config: w.config, group: nameOf.get(w.groupId) ?? null })),
    };
  }, { perm: 'data:export' });

  route('POST', '/api/import', async (ctx) => {
    const list = Array.isArray(ctx.body.watches) ? ctx.body.watches : [];
    const have = new Set((await ctx.data.listWatches()).map((w) => w.url));
    // Groupes retrouvés par leur nom (sans tenir compte de la casse) ou créés à la volée.
    const byName = new Map((await ctx.data.listGroups()).map((g) => [g.name.toLowerCase(), g.id]));
    const colors = new Map((Array.isArray(ctx.body.groups) ? ctx.body.groups : []).map((g) => [String(g?.name ?? '').toLowerCase(), g.color]));
    const groupFor = async (name) => {
      const n = String(name ?? '').trim();
      if (!n) return null;
      if (!byName.has(n.toLowerCase())) {
        try {
          byName.set(n.toLowerCase(), (await ctx.data.createGroup({ name: n, color: colors.get(n.toLowerCase()) })).id);
        } catch {
          return null; // nom invalide : le site est importé sans groupe
        }
      }
      return byName.get(n.toLowerCase());
    };
    let added = 0;
    for (const it of list.slice(0, 500)) {
      try {
        await ctx.entitle('site:create'); // au-delà du quota, les sites suivants sont ignorés (comptés dans « skipped »)
        const { data } = await watchInput(ctx, { ...it, groupId: undefined });
        data.groupId = await groupFor(it.group);
        if (have.has(data.url)) continue;
        const created = await ctx.data.createWatch(data);
        enqueue(created.id);
        await ctx.app.emit('onWatchCreated', ctx, created);
        have.add(data.url);
        added++;
      } catch {
        /* entrée ignorée */
      }
    }
    return { added, skipped: list.length - added };
  }, { perm: 'data:import' });
}
