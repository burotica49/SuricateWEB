// Point d'accès au moteur de base de données : SQLite par défaut, remplaçable AVANT le premier import de src/db.js.
//
// La version hébergée (PostgreSQL) fait, dans son point d'entrée :
//
//     import { configureStore } from '<cœur>/src/store/registry.js';
//     configureStore({ open: async () => openPostgres(process.env.DATABASE_URL), migrations: [m1000Comptes], secrets: { seal, open } });
//     await import('<cœur>/server.js');   // db.js s'ouvre alors sur l'adaptateur fourni
//
// `open` renvoie un adaptateur (contrat : src/store/sqlite.js). `migrations` s'ajoutent à celles du cœur : numéros à partir de
// 1000 (le cœur garde les numéros en dessous, sans collision possible), et chacune doit exister pour tous les moteurs utilisés.
import { openSqlite } from './sqlite.js';

let customOpen = null;
let secretCodec = null;
const extraMigrations = [];

/**
 * `secrets` : { seal(texte) → texte chiffré préfixé « v1: », open(texte chiffré) → texte } — chiffre au repos les secrets que le
 * cœur stocke dans les réglages (le jeton du bot Telegram). Sans lui, tout reste en clair, comme dans une installation personnelle.
 */
export function configureStore({ open, migrations = [], secrets } = {}) {
  if (open) customOpen = open;
  if (secrets) {
    if (typeof secrets.seal !== 'function' || typeof secrets.open !== 'function') throw new Error('secrets doit fournir seal() et open()');
    secretCodec = secrets;
  }
  extraMigrations.push(...migrations);
}

export const getExtraMigrations = () => [...extraMigrations];
export const getSecretCodec = () => secretCodec;

/** Remet les valeurs d'origine (tests). */
export function resetStore() {
  customOpen = null;
  secretCodec = null;
  extraMigrations.length = 0;
}

/** Ouvre la base : l'adaptateur configuré, sinon SQLite dans `path`. */
export async function openStore({ path, dataDir }) {
  if (customOpen) return customOpen({ path, dataDir });
  try {
    return openSqlite(path);
  } catch (e) {
    // SQLITE_CANTOPEN (14) : le dossier existe mais n'est pas inscriptible (volume Docker root:root, typiquement).
    if (e?.errcode === 14) {
      const uid = typeof process.getuid === 'function' ? process.getuid() : '?';
      console.error(`Impossible d'ouvrir ${path} : accès refusé en écriture (uid ${uid}).`);
      console.error(`Le dossier ${dataDir} doit être accessible en écriture à cet utilisateur. Avec Docker, montez un volume sur ce chemin et redéployez : l'image en corrige les droits au démarrage.`);
      process.exit(1);
    }
    throw e;
  }
}
