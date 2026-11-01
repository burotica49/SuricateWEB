// Charge le fichier .env (à la racine du projet, ou ENV_FILE) AVANT le reste de l'application :
// la base de données lit DATA_DIR dès son import. Les variables déjà définies (Docker, Dokploy…) ne sont jamais écrasées.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ENV_FILE = process.env.ENV_FILE || join(dirname(fileURLToPath(import.meta.url)), '..', '.env');

try {
  process.loadEnvFile(ENV_FILE);
} catch (e) {
  if (e.code !== 'ENOENT') console.error(`⚠  Fichier .env illisible (${ENV_FILE}) : ${e.message}`);
}
