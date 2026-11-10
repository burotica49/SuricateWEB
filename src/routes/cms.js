// Connecteur WordPress / PrestaShop : téléchargement des plugins, relevé à la demande, « Je connais ces comptes ».
import { HttpError } from '../http.js';
import { join } from 'node:path';
import { pollCms, acceptCmsAdmins, acceptCmsCode } from '../cms.js';
import { zipDirectory } from '../zip.js';
import { bus } from '../events.js';

export default function register({ route }) {
  route('GET', '/api/plugins/:file', (ctx) => {
    const dir = { 'wordpress.zip': 'wordpress', 'prestashop.zip': 'prestashop' }[ctx.params.file];
    if (!dir) throw new HttpError(404, 'Plugin introuvable');
    const buf = zipDirectory(join(ctx.app.root, 'plugins', dir, 'suricateweb'), 'suricateweb');
    ctx.res.writeHead(200, {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="suricateweb-${dir}.zip"`,
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

  // « Je connais ce fichier » : un fichier signalé (chemin dans le corps) ou, sans chemin, tous ceux qui le sont, reconnus avec leur empreinte actuelle.
  route('POST', '/api/watches/:id/cms/code/accept', async (ctx) => {
    const w = await ctx.data.requireWatch(Number(ctx.params.id));
    const path = typeof ctx.body?.path === 'string' ? ctx.body.path.slice(0, 200) : '';
    if (!await acceptCmsCode(w.id, path)) throw new HttpError(400, 'Aucun fichier signalé à reconnaître pour ce site');
    bus.emit('event', { type: 'ack', watchId: w.id });
    return { ok: true };
  }, { perm: 'site:ack' });

}
