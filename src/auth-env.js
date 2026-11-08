// Fournisseur d'authentification par défaut : UN compte, dont les identifiants viennent de l'environnement (.env).
// Cookie de session signé (HMAC), sans état côté serveur : changer le mot de passe déconnecte tout le monde (voir auth.js).
//
// Un fournisseur d'authentification (celui-ci, ou celui de la version hébergée) est un objet :
//   { authenticate(req) → { user, account } | null   (valeur ou promesse ; null = non connecté, la requête reçoit 401)
//     register({ route })                              enregistre ses routes PUBLIQUES : au minimum GET /api/auth
//                                                      (état de connexion, aussi lu par la sonde de santé Docker),
//                                                      plus connexion et déconnexion }
// `user` et `account` sont exposés aux gestionnaires de routes (ctx.user, ctx.account) et aux extensions.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { HttpError, clientIpOf } from './http.js';
import { checkLogin, sessionKey } from './auth.js';

const SESSION_DAYS = 30;

/**
 * @param creds  { user, password } lus par readCredentials()
 * @param getSettings  donne le secret de signature des sessions (réglages de l'installation)
 * @param trustProxy  true derrière un reverse proxy de confiance : cookie « Secure » et vraie IP du client
 */
export function createEnvAuth({ creds, getSettings, trustProxy = false }) {
  const sign = (v) => createHmac('sha256', sessionKey(creds, getSettings().sessionSecret)).update(v).digest('hex');

  function makeSession() {
    const exp = String(Date.now() + SESSION_DAYS * 864e5);
    return `${exp}.${sign(exp)}`;
  }

  function validSession(req) {
    const m = /(?:^|;\s*)vigie_session=([^;]+)/.exec(req.headers.cookie || '');
    if (!m) return false;
    const [exp, sig] = m[1].split('.');
    if (!exp || !sig || Number(exp) < Date.now()) return false;
    const a = Buffer.from(sig);
    const b = Buffer.from(sign(exp));
    return a.length === b.length && timingSafeEqual(a, b);
  }

  const sessionCookie = (req, value, maxAge) =>
    `vigie_session=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${trustProxy && req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''}`;

  // Cinq tentatives par minute et par adresse : assez pour une faute de frappe, trop peu pour deviner un mot de passe.
  const attempts = new Map();

  // L'identité d'une installation à compte unique : toujours la même.
  const identity = { user: { id: 1, name: creds.user }, account: { id: 1 } };

  return {
    kind: 'env',

    authenticate: (req) => (validSession(req) ? identity : null),

    register({ route }) {
      route('GET', '/api/auth', (ctx) => ({ required: true, authenticated: validSession(ctx.req) }), { public: true });

      route('POST', '/api/login', (ctx) => {
        const ip = clientIpOf(ctx.req, trustProxy);
        const a = attempts.get(ip) || { n: 0, t: Date.now() };
        if (Date.now() - a.t > 60e3) Object.assign(a, { n: 0, t: Date.now() });
        if (a.n >= 5) throw new HttpError(429, 'Trop de tentatives, réessayez dans une minute');
        a.n++;
        attempts.set(ip, a);
        if (!checkLogin(creds, ctx.body.username, String(ctx.body.password ?? ''))) throw new HttpError(401, 'Identifiant ou mot de passe incorrect');
        attempts.delete(ip);
        ctx.headers['set-cookie'] = sessionCookie(ctx.req, makeSession(), SESSION_DAYS * 86400);
        return { ok: true };
      }, { public: true });

      route('POST', '/api/logout', (ctx) => {
        ctx.headers['set-cookie'] = sessionCookie(ctx.req, '', 0);
        return { ok: true };
      }, { public: true });
    },
  };
}
