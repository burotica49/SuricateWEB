// Sites surveillés : liste, création, détail, modification, suppression, pause, contrôle immédiat, acquittement, test d'adresse.
import { settingsFor, updateWatch, deleteWatch, normalizeConfig, closeOutage, listMaintenance, recentChecks, markWatchAlertsRead } from '../db.js';
import { enqueue } from '../scheduler.js';
import { resolvePage } from '../pages.js';
import { phpSupport } from '../cms-alerts.js';
import { removeWatchShots, pruneWatchShots } from '../screenshot.js';
import { fetchPage, analyze, describeError } from '../checker.js';
import { bus } from '../events.js';
import { registrable } from '../util.js';
import { normalizeUrl, SELECTOR_CHECK, RESET_KEYS, rememberDomainAck, summarize, buildCtx, watchInput, loadWatch } from './shared.js';

export default function register({ route }) {
  route('GET', '/api/watches', async (ctx) => {
    const dash = await buildCtx(ctx);
    const out = [];
    for (const w of await ctx.data.listWatches()) out.push(await summarize(w, dash));
    return out;
  }, { perm: 'site:read' });

  route('POST', '/api/watches', async (ctx) => {
    await ctx.entitle('site:create'); // forfait : nombre de sites (aucune limite dans le cœur)
    const { data, cfg } = await watchInput(ctx, ctx.body);
    await SELECTOR_CHECK(cfg);
    let w = await ctx.data.createWatch(data);
    if (w.config.cms.type) w = await updateWatch(w.id, { nextCms: Date.now() });
    enqueue(w.id);
    await ctx.app.emit('onWatchCreated', ctx, w);
    return await summarize(w, await buildCtx(ctx));
  }, { perm: 'site:create' });

  route('GET', '/api/watches/:id', async (ctx) => {
    const w = await ctx.data.requireWatch(Number(ctx.params.id));
    const checks = await recentChecks(w.id, 200);
    const { state } = w;
    return {
      ...(await summarize(w, await buildCtx(ctx))),
      config: w.config,
      createdAt: w.createdAt,
      checks,
      signals: {
        dns: state.dns || null, resolvers: state.resolvers || {}, tls: state.tls || null, rdap: state.rdap?.unsupported ? { unsupported: true } : state.rdap || null,
        server: state.server || '', scripts: state.scripts?.length ?? null, linkHosts: state.linkHosts?.length ?? null,
        baseline: !!state.baseline,
      },
      cms: state.cms ? { ...state.cms, phpSupport: phpSupport(state.cms.php) } : null,
      pages: w.config.pages.map((p) => {
        const href = resolvePage(w.url, p);
        const st = href ? state.pages?.[href] : null;
        return { url: p.url, label: p.label, href, state: st ? { code: st.code ?? null, ms: st.ms ?? null, title: st.title ?? '', error: st.error ?? null, checkedAt: st.checkedAt ?? null, fails: st.fails || 0, baseline: !!st.baseline } : null };
      }),
      maintenance: await listMaintenance(w.id),
    };
  }, { perm: 'site:read' });

  route('PUT', '/api/watches/:id', async (ctx) => {
    const w = await ctx.data.requireWatch(Number(ctx.params.id));
    const { data, cfg } = await watchInput(ctx, ctx.body, w);
    await SELECTOR_CHECK(cfg);
    const state = { ...w.state };
    if (data.url !== w.url || RESET_KEYS.some((k) => JSON.stringify(cfg[k]) !== JSON.stringify(w.config[k]))) state.baseline = false;
    // Nouvelle adresse ou réglages de capture modifiés : on recapture sans attendre l'échéance.
    // (la limite de conservation n'a aucun effet sur l'image : la modifier ne déclenche pas de capture)
    const sameLook = ({ keep, ...look }) => JSON.stringify(look);
    const reshoot = data.url !== w.url || sameLook(cfg.screenshot) !== sameLook(w.config.screenshot);
    const cmsOn = cfg.mode !== 'domain' && !!cfg.cms.type;
    const cmsChanged = JSON.stringify(cfg.cms) !== JSON.stringify(w.config.cms) || data.url !== w.url;
    const nextCms = cmsOn ? (cmsChanged || !(w.nextCms > 0) ? Date.now() : w.nextCms) : 0;
    const u = await updateWatch(w.id, { ...data, state, nextRun: data.enabled ? 0 : w.nextRun, ...(reshoot ? { nextShot: 0 } : {}), nextCms });
    await pruneWatchShots(u.id); // une limite abaissée s'applique tout de suite
    await ctx.app.emit('onWatchUpdated', ctx, u);
    return await summarize(u, await buildCtx(ctx));
  }, { perm: 'site:update' });

  route('DELETE', '/api/watches/:id', async (ctx) => {
    const { id } = await ctx.data.requireWatch(Number(ctx.params.id));
    await deleteWatch(id);
    await removeWatchShots(id);
    await ctx.app.emit('onWatchDeleted', ctx, id);
    return { ok: true };
  }, { perm: 'site:delete' });

  route('POST', '/api/watches/:id/check', async (ctx) => {
    const id = Number(ctx.params.id);
    await ctx.data.requireWatch(id);
    const r = await enqueue(id, { wait: true });
    return { ok: true, result: r && { code: r.code, ms: r.ms, error: r.error, alerts: r.alerts?.length || 0 } };
  }, { perm: 'site:check' });

  route('POST', '/api/watches/:id/toggle', async (ctx) => {
    const w = await ctx.data.requireWatch(Number(ctx.params.id));
    if (!w.enabled) await ctx.entitle('site:enable'); // reprendre la surveillance compte dans le forfait
    // Mettre en pause clôt une panne en cours : le temps en pause ne doit pas compter comme indisponibilité.
    const state = { ...w.state };
    if (w.enabled && state.outageId) {
      await closeOutage(state.outageId, Date.now());
      Object.assign(state, { outageId: null, failSince: null, fails: 0 });
    }
    const u = await updateWatch(w.id, { enabled: !w.enabled, nextRun: 0, state });
    return await summarize(u, await buildCtx(ctx));
  }, { perm: 'site:update' });

  route('POST', '/api/watches/:id/ack', async (ctx) => {
    const { id } = await loadWatch(ctx);
    await markWatchAlertsRead(id);
    await rememberDomainAck(id);
    bus.emit('event', { type: 'ack', watchId: id });
    return { ok: true };
  }, { perm: 'site:ack' });

  route('POST', '/api/test-url', async (ctx) => {
    const url = normalizeUrl(ctx.body.url);
    const s = await settingsFor(ctx.account.id);
    const cfg = normalizeConfig({ timeoutS: 12 });
    try {
      const p = await fetchPage(url, cfg, s);
      const a = analyze(p, cfg);
      return { ok: true, status: p.status, ms: p.ms, finalUrl: p.finalUrl, title: a.title, redirected: p.chain.length > 1, size: p.size, server: p.server, offDomain: registrable(new URL(p.finalUrl).hostname) !== registrable(new URL(url).hostname) };
    } catch (e) {
      return { ok: false, error: describeError(e).message };
    }
  }, { perm: 'site:create' });

}
