// Connecteur WordPress / PrestaShop : téléchargement des plugins, relevé à la demande, « Je connais ces comptes ».
import { HttpError } from '../http.js';
import { join } from 'node:path';
import { pollCms, acceptCmsAdmins } from '../cms.js';
import { zipDirectory } from '../zip.js';
import { bus } from '../events.js';

export default function register({ route }) {
  route('GET', '/api/plugins/:file', (ctx) => {
    const dir = { 'wordpress.zip': 'wordpress', 'prestashop.zip': 'prestashop' }[ctx.params.file];
    if (!dir) throw new HttpError(404, 'Plugin introuvable');
    const buf = zipDirectory(join(ctx.app.root, 'plugins', dir, 'vigieweb'), 'vigieweb');
    ctx.res.writeHead(200, {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="vigieweb-${dir}.zip"`,
      'content-length': String(buf.length),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    ctx.res.end(buf);
    return Symbol.for('handled');
  }, { perm: 'plugin:download' });

  route('POST', '/api/watches/:id/cms', async (ctx) => {
    const w = await ctx.data.requireWatch(Number(ctx.params.id));
    if (w.config.mode === 'domain' || !w.config.cms.type) throw new HttpError(400, 'Aucun CMS configuré pour ce site');
    return pollCms(w.id, { refresh: true });
  }, { perm: 'site:check' });

  // « Je connais ces comptes » : les administrateurs actuels deviennent la référence.
  route('POST', '/api/watches/:id/cms/admins/accept', async (ctx) => {
    const w = await ctx.data.requireWatch(Number(ctx.params.id));
    if (!await acceptCmsAdmins(w.id)) throw new HttpError(400, 'Aucun relevé des administrateurs pour ce site');
    bus.emit('event', { type: 'ack', watchId: w.id });
    return { ok: true };
  }, { perm: 'site:ack' });

}
