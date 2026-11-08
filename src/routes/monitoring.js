// Suivi d'un site : disponibilité, courbe de réponse, domaine et DNS, historique des versions, comparaison, fenêtres de maintenance.
import { HttpError } from '../http.js';
import { getWatch, getSnapshot, previousSnapshot, snapshotLines, uptimeSummary, uptimeBars, outageList, responseStats, responseSeries, DAY_MS, UPTIME_PERIODS, addMaintenance, listMaintenance, endMaintenance, snapshotHistory, currentOutage, lastOutageEnd, domainAlerts } from '../db.js';
import { enqueue } from '../scheduler.js';
import { diffLines, collapse } from '../diff.js';
import { clamp, registrable } from '../util.js';
import { alertRow, loadWatch } from './shared.js';

export default function register({ route }) {
  route('POST', '/api/watches/:id/maintenance', async (ctx) => {
    const w = await getWatch(Number(ctx.params.id));
    if (!w) throw new HttpError(404, 'Site introuvable');
    const now = Date.now();
    const minutes = Math.round(clamp(ctx.body.minutes, 5, 7 * 24 * 60, 60));
    const asked = Number(ctx.body.start);
    // Un début absent ou déjà passé veut dire « maintenant » ; au plus 90 jours à l'avance.
    const start = Number.isFinite(asked) && asked > now ? Math.min(asked, now + 90 * DAY_MS) : now;
    const note = String(ctx.body.note ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 140);
    await addMaintenance({ watchId: w.id, start, end: start + minutes * 60e3, note });
    return { ok: true, maintenance: await listMaintenance(w.id) };
  }, { perm: 'maintenance:write' });

  route('DELETE', '/api/maintenance/:id', async (ctx) => {
    const r = await endMaintenance(Number(ctx.params.id));
    if (!r) throw new HttpError(404, 'Fenêtre introuvable ou déjà terminée');
    // Fenêtre arrêtée avant son terme : la surveillance reprend aussitôt (le récapitulatif part sans attendre l'échéance prévue).
    if (r.start <= Date.now()) enqueue(r.watchId);
    return { ok: true, maintenance: await listMaintenance(r.watchId) };
  }, { perm: 'maintenance:write' });

  route('GET', '/api/watches/:id/uptime', async (ctx) => {
    const w = await loadWatch(ctx);
    const now = Date.now();
    const open = await currentOutage(w.id);
    const lastEnd = await lastOutageEnd(w.id);
    const current = !w.enabled ? { state: 'paused' } : open ? { state: 'down', since: open.start, reason: open.reason } : { state: 'up', since: lastEnd || w.createdAt };
    return {
      current,
      periods: await uptimeSummary(w, now),
      // Jours calendaires du navigateur : il transmet son décalage UTC en minutes (ex. +60 pour Paris en hiver).
      bars: await uptimeBars(w, clamp(ctx.query.get('tz'), -840, 840, 0), now),
      outages: await outageList(w.id, 50, now),
      response: Object.fromEntries(await Promise.all(Object.entries(UPTIME_PERIODS).map(async ([k, d]) => [k, await responseStats(w.id, d, now)]))),
      since: w.createdAt,
    };
  }, { perm: 'site:read' });

  route('GET', '/api/watches/:id/series', async (ctx) => {
    const w = await loadWatch(ctx);
    const range = ['24h', '7d', '30d', '90d'].includes(ctx.query.get('range')) ? ctx.query.get('range') : '24h';
    return { range, points: await responseSeries(w.id, range) };
  }, { perm: 'site:read' });

  route('GET', '/api/watches/:id/domain', async (ctx) => {
    const w = await loadWatch(ctx);
    const s = w.state;
    const host = new URL(w.url).hostname;
    const events = await domainAlerts(w.id, 100);
    const incidents = Object.entries(s.incidents || {}).filter(([k]) => /^(dns|rdap)/.test(k)).map(([key, i]) => ({ key, ...i }));
    return {
      host, domain: registrable(host), zone: s.dns?.zone || '', mode: w.config.mode,
      dns: s.dns || null, resolvers: s.resolvers || {}, rdap: s.rdap || null, incidents, events: events.map(alertRow),
      monitored: { dns: w.config.checks.dns, rdap: w.config.checks.rdap },
    };
  }, { perm: 'site:read' });

  route('GET', '/api/watches/:id/history', async (ctx) => {
    const id = Number(ctx.params.id);
    const rows = await snapshotHistory(id, 100);
    return rows.map((r) => ({ id: r.id, ts: r.ts, title: r.title, size: r.size, meta: JSON.parse(r.meta || '{}') }));
  }, { perm: 'site:read' });

  route('GET', '/api/snapshots/:id/diff', async (ctx) => {
    const cur = await getSnapshot(Number(ctx.params.id));
    if (!cur) throw new HttpError(404, 'Version introuvable (supprimée par la rétention ?)');
    const against = ctx.query.get('against');
    const prev = against ? await getSnapshot(Number(against)) : await previousSnapshot(cur.watch_id, cur.id);
    const a = snapshotLines(prev);
    const b = snapshotLines(cur);
    const d = diffLines(a, b);
    return {
      from: prev ? { id: prev.id, ts: prev.ts } : null, to: { id: cur.id, ts: cur.ts },
      added: d.added, removed: d.removed, similarity: d.similarity, hunks: collapse(d.ops, 3),
    };
  }, { perm: 'site:read' });

  route('GET', '/api/snapshots/:id/text', async (ctx) => {
    const s = await getSnapshot(Number(ctx.params.id));
    if (!s) throw new HttpError(404, 'Version introuvable');
    return { id: s.id, ts: s.ts, lines: snapshotLines(s) };
  }, { perm: 'site:read' });
}
