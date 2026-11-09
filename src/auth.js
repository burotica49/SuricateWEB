// Identifiants de connexion : définis uniquement par l'environnement (.env ou variables du conteneur).
// Rien n'est stocké en base : changer le mot de passe = modifier le .env et redémarrer.
import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (s) => createHash('sha256').update(String(s)).digest();

export const MIN_PASSWORD = 8;

export const MISSING_HELP = `
  ✖  SuricateWeb est protégé par identifiant et mot de passe, mais ils ne sont pas définis.

     Créez un fichier .env à la racine du projet (modèle : .env.example) :

         SURICATE_USER=admin
         SURICATE_PASSWORD=un-mot-de-passe-solide

     ou définissez ces deux variables d'environnement (Docker, Dokploy…).
     Générer un mot de passe :  node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))"
`;

/** Lit SURICATE_USER / SURICATE_PASSWORD. Retourne { user, password, defaultedUser } ou { error }. */
export function readCredentials(env = process.env) {
  const password = env.SURICATE_PASSWORD || '';
  const user = (env.SURICATE_USER || '').trim();
  if (!password) return { error: MISSING_HELP };
  if (password.length < MIN_PASSWORD) return { error: `\n  ✖  SURICATE_PASSWORD est trop court : ${MIN_PASSWORD} caractères minimum.\n` };
  // Compatibilité : un déploiement qui ne définissait que SURICATE_PASSWORD garde l'identifiant « admin ».
  return { user: user || 'admin', password, defaultedUser: !user };
}

/** Comparaison en temps constant ; les deux champs sont toujours évalués (pas de fuite sur l'identifiant). */
export function checkLogin(creds, user, password) {
  const okUser = timingSafeEqual(digest(String(user ?? '').trim()), digest(creds.user));
  const okPass = timingSafeEqual(digest(password ?? ''), digest(creds.password));
  return okUser && okPass;
}

/** Clé de signature des sessions : liée aux identifiants, donc changer le mot de passe déconnecte tout le monde. */
export const sessionKey = (creds, secret) => `${secret}:${digest(`${creds.user}\0${creds.password}`).toString('hex')}`;
