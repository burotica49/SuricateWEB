// SuricateWeb — l'application : serveur HTTP + API, assemblés par createApp().
//
// Le cœur open source l'appelle avec les valeurs par défaut (un compte, identifiants du .env, aucune limite).
// La version hébergée l'appelle avec ses propres extensions : comptes, droits, quotas, routes, canaux de notification.
//
//   const app = createApp({
//     env,            variables d'environnement (défaut : process.env) — le serveur ne lit pas process.env ailleurs
//     auth,           fournisseur d'authentification (voir src/auth-env.js) ; défaut : identifiants du .env
//     authorize,      (ctx, action, ressource) → booléen. Défaut : tout est permis. Appelé pour la `perm` de chaque route
//                     (voir PERMS ci-dessous) et par ctx.can() / ctx.require() dans le code des routes.
//     entitlements,   { check(ctx, action, info), limits(ctx) } : quotas du forfait. `check` lève une HttpError (402, 403…)
//                     pour refuser ; `limits` renvoie des plafonds (ex. { minIntervalMin: 5, screenshots: false }). Défaut : aucune limite.
//                     `limits` est aussi appelé SANS requête (captures planifiées ou d'alerte) avec { account: { id } } seulement.
//     routes,         [(api) => void] : routes supplémentaires, via api.route(méthode, chemin, gestionnaire, { public, perm, raw })
//                     raw: true (ou une taille en octets) : le corps n'est pas analysé, le gestionnaire reçoit ctx.rawBody (Buffer) —
//                     indispensable pour vérifier la signature d'un webhook (Stripe…), qui porte sur les octets exacts
//     hooks,          { onWatchCreated(ctx, site), onWatchUpdated(ctx, site), onWatchDeleted(ctx, id), onStart(app), onStop(app) }
//                     — informatifs : une erreur y est journalisée, jamais renvoyée au client
//     notifier,       { resolveChannels(site, alertes, réglages) } : canaux de notification (src/notify.js)
//     netGuard,       garde réseau (src/net-guard.js) : createNetGuard({ enabled, allowedPorts, allowHosts }) ou ses options.
//                     Défaut : celle de l'environnement (SURICATE_NET_GUARD=1), sinon inerte. À ACTIVER dès que des inconnus ajoutent des sites.
//     scheduler,      { concurrency, pickDue(now, limite) } : planificateur (src/extensions.js)
//     capabilities,   fusionné dans GET /api/capabilities (ex. { mode: 'cloud', billing: true }). L'interface lit aussi :
//                       accountLinks  [{ label, href }]  liens affichés sous le menu (ex. « Mon forfait »), chemins du même site seulement
//                       usageUrl      '/api/…'  jauge d'usage : GET renvoie { plan: { name, limits?: { minIntervalMin } }, usage: { sites: { active, max } } } (max null = illimité ;
//                                     `limits.minIntervalMin` : l'interface ne propose aucune fréquence de contrôle ou de capture en dessous)
//                       scopeLinks    [{ label, href, icon }]  boutons par groupe (en-tête) et par site (fiche) ; mènent à `href?scope=group|site&id=N`
//     home,           async ({ req, res, identity }) → booléen : appelé pour GET et HEAD « / » (et pour eux seuls), avant le service du
//                     dossier public/. `identity` = auth.authenticate(req), ou null sans session valide. Renvoie true s'il a répondu
//                     (ex. une page de présentation pour les visiteurs) ; false : l'application est servie, comme sans cette option.
//                     Une erreur du gestionnaire ou de l'authentification ne bloque jamais l'application : elle est servie.
//     root,           racine du cœur (public/, plugins/, package.json) ; défaut : celle de ce dépôt
//   });
//   await app.listen(3000, '127.0.0.1');
//   app.startBackground();   // planificateur + lecteur Telegram
//
// Un seul app par processus : le planificateur et les contrôles sont uniques dans le processus.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSettings, getInstanceSettings, markAlertsReadUpTo, GroupError } from './db.js';
import { startScheduler } from './scheduler.js';
import { startTelegramPoller } from './telegram-poll.js';
import { configureExtensions } from './extensions.js';
import { createNetGuard, netGuardFromEnv } from './net-guard.js';
import { bus } from './events.js';
import { HttpError, HANDLED, send, sendHtml, readJson, readRaw, MAX_BODY, clientIpOf } from './http.js';
import { readCredentials } from './auth.js';
import { scopedData } from './scoped.js';
import { createEnvAuth } from './auth-env.js';
import { rememberDomainAck } from './routes/shared.js';
import { createStaticHandler } from './routes/static.js';
import { createStatusPageHandler } from './routes/status-page.js';
import registerMeta from './routes/meta.js';
import registerWatches from './routes/watches.js';
import registerMonitoring from './routes/monitoring.js';
import registerScreenshots from './routes/screenshots.js';
import registerCms from './routes/cms.js';
import registerReports from './routes/reports.js';
import registerGroups from './routes/groups.js';
import registerAlerts from './routes/alerts.js';
import registerSettings from './routes/settings.js';
import registerData from './routes/data.js';
import registerEvents from './routes/events.js';

const CORE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Actions soumises à `authorize`. Chaque route du cœur en déclare une (`perm`) ; une extension peut en ajouter pour ses routes.
 * site:read · site:create · site:update · site:delete · site:check (contrôle, capture, relevé CMS à la demande) · site:ack
 * maintenance:write · group:read · group:write · alert:read · alert:ack · settings:read · settings:write
 * data:export · data:import · report:read · plugin:download
 * instance:write — modifier un réglage de l'INSTALLATION (adresse publique) : à refuser aux comptes clients de la version hébergée
 */
const allowAll = () => true;
const noLimits = { check: () => {}, limits: () => ({}) };

export function createApp({
  env = process.env,
  auth,
  authorize = allowAll,
  entitlements = noLimits,
  routes: extraRoutes = [],
  hooks = {},
  notifier,
  scheduler,
  netGuard,
  capabilities = {},
  home = null,
  root = CORE_ROOT,
} = {}) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  // Version et liens affichés dans la barre latérale : package.json est la source unique (rien à mettre à jour ailleurs).
  const webUrl = (u) => {
    const clean = String(u ?? '').replace(/^git\+/, '').replace(/\.git$/, '');
    return /^https?:\/\//.test(clean) ? clean : null; // seul http(s) : jamais de « javascript: » dans un lien
  };
  const repoUrl = webUrl(pkg.repository?.url ?? pkg.repository);
  const info = { version: String(pkg.version ?? ''), repoUrl, docsUrl: webUrl(pkg.homepage) ?? (repoUrl ? `${repoUrl}#readme` : null) };

  // Derrière un reverse proxy (Dokploy/Traefik, nginx…) : TRUST_PROXY=1 active la lecture de X-Forwarded-*.
  const trustProxy = /^(1|true|yes)$/i.test(env.TRUST_PROXY || '');
  const clientIp = (req) => clientIpOf(req, trustProxy);

  if (!auth) {
    const creds = readCredentials(env);
    if (creds.error) throw new Error(creds.error);
    auth = createEnvAuth({ creds, getSettings: getInstanceSettings, trustProxy });
  }
  // Garde réseau : un objet createNetGuard(), des options pour en créer une, ou l'environnement ; sinon on ne touche à rien.
  const guard = netGuard?.fetch ? netGuard : netGuard ? createNetGuard(netGuard) : netGuardFromEnv(env);
  configureExtensions({ notifier, scheduler, entitlements, ...(guard ? { netGuard: guard } : {}) });

  // Contexte commun à tous les gestionnaires (ctx.app) : ce que les routes ont besoin de savoir de l'application.
  const app = {
    info, root, env, trustProxy, clientIp, auth, entitlements,
    capabilities: { mode: 'self-hosted', multiUser: false, billing: false, ...capabilities },
    /** Appelle un hook s'il existe ; son échec est journalisé, jamais propagé. */
    async emit(name, ...args) {
      try {
        await hooks[name]?.(...args);
      } catch (e) {
        console.error(`[hook ${name}]`, e);
      }
    },
  };

  // ───────────── Routeur ─────────────

  const table = [];
  const route = (method, path, handler, opts = {}) => {
    if (table.some((r) => r.method === method && r.path === path)) throw new Error(`Route déjà déclarée : ${method} ${path}`);
    const keys = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$');
    table.push({ method, path, re, keys, handler, ...opts });
  };
  const api = { route, app, HttpError, HANDLED, send, sendHtml };

  auth.register(api); // d'abord : connexion, déconnexion, état (GET /api/auth)
  for (const register of [registerMeta, registerWatches, registerMonitoring, registerScreenshots, registerCms, registerReports, registerGroups, registerAlerts, registerSettings, registerData, registerEvents]) register(api);
  for (const register of extraRoutes) register(api);

  // ───────────── Serveur ─────────────

  const serveStatic = createStaticHandler(join(root, 'public'));
  const serveStatusPage = createStatusPageHandler({ clientIp });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    try {
      const status = req.method === 'GET' && /^\/status\/([A-Za-z0-9_-]{1,80})\/?$/.exec(url.pathname);
      if (status) return await serveStatusPage(req, res, status[1], url.searchParams);
      if (home && url.pathname === '/' && (req.method === 'GET' || req.method === 'HEAD')) {
        // À cette adresse, la réponse dépend de la session : visiteur → page d'accueil, compte connecté → application. `vary: cookie`
        // empêche un cache intermédiaire (CDN, proxy) de resservir l'une à la place de l'autre.
        res.setHeader('vary', 'cookie');
        // Une erreur (base indisponible, gestionnaire défaillant) ne doit jamais fermer l'application : on la sert.
        const identity = await Promise.resolve().then(() => auth.authenticate(req)).catch(() => null);
        let answered = false;
        try { answered = !!(await home({ req, res, identity })); } catch (e) { console.error('[home]', e.message); }
        if (answered || res.headersSent) return;
      }
      if (!url.pathname.startsWith('/api/')) return await serveStatic(req, res, url.pathname);
      const r = table.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (!r) return send(res, 404, { error: 'Route inconnue' });
      const identity = r.public ? null : await auth.authenticate(req);
      if (!r.public && !identity) return send(res, 401, { error: 'Authentification requise' });
      // Protection CSRF : un navigateur ne peut pas poster du JSON cross-origin sans pré-requête CORS.
      // Une route « raw » (webhook d'un service tiers) en est dispensée : elle s'authentifie elle-même, par la signature du corps.
      const hasBody = Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding'];
      if (req.method !== 'GET' && hasBody && !r.raw && !/application\/json/.test(req.headers['content-type'] || '')) {
        return send(res, 415, { error: 'Content-Type application/json requis' });
      }
      if (req.method !== 'GET' && !r.public && !hasBody && !req.headers['content-type'] && req.headers['sec-fetch-site'] === 'cross-site') {
        return send(res, 403, { error: 'Requête inter-sites refusée' });
      }
      const m = r.re.exec(url.pathname);
      const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
      const ctx = {
        req, res, params, query: url.searchParams, body: {}, headers: {}, app,
        user: identity?.user ?? null, account: identity?.account ?? null,
        /** Accès aux données limité au compte de l'utilisateur (src/scoped.js) ; null sur une route publique. */
        data: identity ? scopedData(identity.account?.id) : null,
      };
      /** Le droit d'effectuer `action` (sur `resource`, si l'extension en tient compte) ? */
      ctx.can = async (action, resource) => !!(await authorize(ctx, action, resource));
      /** Comme ctx.can, mais refuse la requête (403) si la réponse est non. */
      ctx.require = async (action, resource) => {
        if (!(await ctx.can(action, resource))) throw new HttpError(403, 'Accès refusé');
      };
      /** Le forfait permet-il `action` ? Lève une HttpError sinon (ex. « limite de sites atteinte »). */
      ctx.entitle = async (action, details) => entitlements.check(ctx, action, details);
      /** Plafonds du forfait (ex. { minIntervalMin }), {} si aucun. */
      ctx.limits = async () => (await entitlements.limits(ctx)) ?? {};
      if (r.perm) await ctx.require(r.perm);
      if (r.raw) ctx.rawBody = await readRaw(req, typeof r.raw === 'number' ? Math.min(r.raw, 20e6) : MAX_BODY); // octets bruts, rien n'est analysé
      else ctx.body = req.method === 'GET' ? {} : await readJson(req);
      const out = await r.handler(ctx);
      if (out === HANDLED) return;
      send(res, 200, out, ctx.headers);
    } catch (e) {
      if (e instanceof HttpError || e instanceof GroupError) return send(res, e.status, { error: e.message });
      console.error(e);
      if (!res.headersSent) send(res, 500, { error: 'Erreur interne' });
    }
  });

  let poller = null;
  let schedulerTimer = null;

  const handle = {
    server, info, auth,
    /** Les routes déclarées (documentation, tests) : [{ method, path, public, perm, raw }]. */
    routes: () => table.map(({ method, path, public: isPublic, perm, raw }) => ({ method, path, public: !!isPublic, perm: perm ?? null, raw: !!raw })),

    /** Démarre l'écoute HTTP. Résolu quand le serveur accepte les connexions ; renvoie le port effectif (utile avec 0). */
    listen: (port, host) => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve(server.address().port);
      });
    }),

    /** Planificateur et lecteur des boutons Telegram. TELEGRAM_POLL=0 désactive le second ; inutile en mode démo. */
    startBackground() {
      schedulerTimer = startScheduler();
      if (env.SURICATE_DEMO !== '1' && env.TELEGRAM_POLL !== '0') {
        poller = startTelegramPoller({
          settings: () => getSettings().telegram,
          onRead: async (watchId, upTo) => {
            const rows = await markAlertsReadUpTo(watchId, upTo);
            if (rows.some((r) => r.type === 'rdap_expiring')) await rememberDomainAck(watchId); // comme « Tout est normal »
            if (rows.length) bus.emit('event', { type: 'ack', watchId });
            return rows.length;
          },
        });
      }
      return app.emit('onStart', handle);
    },

    /** Arrête le serveur et les tâches de fond. N'arrête pas la base : c'est au point d'entrée de le faire. */
    async stop() {
      poller?.stop();
      if (schedulerTimer) clearInterval(schedulerTimer);
      // Le flux temps réel (SSE) garde des connexions ouvertes : sans les fermer, server.close() n'aboutirait jamais.
      server.closeAllConnections?.();
      await new Promise((resolve) => (server.listening ? server.close(resolve) : resolve()));
      await app.emit('onStop', handle);
    },
  };
  return handle;
}
