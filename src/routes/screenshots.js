// Captures d'écran d'un site : liste, capture à la demande, image (toujours derrière la connexion, jamais un lien public).
import { HttpError } from '../http.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listScreenshots, screenshotStats, settingsFor, SHOTS_DIR } from '../db.js';
import { captureWatch, isCapturing, engine, shotLimits, NO_CHROME } from '../screenshot.js';
import { clamp } from '../util.js';
import { loadWatch } from './shared.js';

export default function register({ route }) {
  route('GET', '/api/watches/:id/screenshots', async (ctx) => {
    const w = await loadWatch(ctx);
    return {
      available: engine.available(),
      enabled: w.config.screenshot.enabled && w.config.mode !== 'domain',
      interval: w.config.screenshot.interval,
      ...shotLimits(w, await settingsFor(ctx.account.id)),
      ...(await screenshotStats(w.id)),
      nextShot: w.nextShot,
      error: w.shotError,
      capturing: isCapturing(w.id),
      items: await listScreenshots(w.id, clamp(ctx.query.get('limit'), 1, 500, 200)),
    };
  }, { perm: 'site:read' });

  route('POST', '/api/watches/:id/screenshot', async (ctx) => {
    const w = await loadWatch(ctx);
    if (w.config.mode === 'domain') throw new HttpError(400, "Un domaine seul n'a pas de page à capturer");
    if (!engine.available()) throw new HttpError(503, NO_CHROME);
    const r = await captureWatch(w.id, { kind: 'manual' });
    if (r.error) throw new HttpError(502, `Capture impossible : ${r.error}`);
    return { id: r.id, ts: r.ts };
  }, { perm: 'site:check' });

  // L'image passe par l'API pour rester derrière la connexion : un lien de capture n'est jamais public.
  route('GET', '/api/screenshots/:id/image', async (ctx) => {
    const s = await ctx.data.getScreenshot(Number(ctx.params.id));
    if (!s) throw new HttpError(404, 'Capture introuvable (supprimée par la rétention ?)');
    const buf = await readFile(join(SHOTS_DIR, ctx.query.get('thumb') && s.thumb ? s.thumb : s.file)).catch(() => null);
    if (!buf) throw new HttpError(404, 'Fichier de capture introuvable');
    ctx.res.writeHead(200, {
      'content-type': 'image/jpeg', 'content-length': buf.length, 'x-content-type-options': 'nosniff',
      'cache-control': 'private, max-age=31536000, immutable', // l'identifiant d'une capture ne change jamais de contenu
    });
    ctx.res.end(buf);
    return Symbol.for('handled');
  }, { perm: 'site:read' });
}
