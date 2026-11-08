// Alertes : liste filtrée, marquage comme lues.
import { bus } from '../events.js';
import { clamp } from '../util.js';
import { rememberDomainAck, alertRow } from './shared.js';

export default function register({ route }) {
  route('GET', '/api/alerts', async (ctx) => {
    const q = ctx.query;
    const rows = await ctx.data.queryAlerts({
      watchId: q.get('watch') ? Number(q.get('watch')) : null,
      severity: q.get('severity') || '',
      unread: q.get('unread') === '1',
      before: q.get('before') ? Number(q.get('before')) : null,
      limit: clamp(q.get('limit'), 1, 200, 50),
    });
    return rows.map(alertRow);
  }, { perm: 'alert:read' });

  route('POST', '/api/alerts/read', async (ctx) => {
    const { ids, all } = ctx.body;
    if (all) {
      await ctx.data.markEveryAlertRead();
      for (const w of await ctx.data.listWatches()) await rememberDomainAck(w.id);
    } else if (Array.isArray(ids) && ids.length) {
      const nums = ids.map(Number).filter((n) => Number.isFinite(n));
      for (const watchId of await ctx.data.markAlertsRead(nums)) await rememberDomainAck(watchId);
    }
    bus.emit('event', { type: 'ack', accountId: ctx.account.id });
    return { ok: true };
  }, { perm: 'alert:ack' });

}
