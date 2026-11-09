// SuricateWEB — point d'entrée : lit l'environnement, assemble l'application (src/app.js) avec ses réglages par défaut,
// l'écoute, puis lance les tâches de fond. Aucune dépendance externe.
import './src/env.js'; // doit rester le 1er import : charge le .env avant l'ouverture de la base
import { createApp } from './src/app.js';
import { getSettings, closeDb } from './src/db.js';
import { engine, chromePath } from './src/screenshot.js';
import { readCredentials } from './src/auth.js';

// L'application ne démarre pas sans identifiants : pas de fenêtre où elle serait ouverte à tous.
const CREDS = readCredentials(process.env);
if (CREDS.error) {
  console.error(CREDS.error);
  process.exit(1);
}

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

const app = createApp({ env: process.env });
await app.listen(PORT, HOST);

const s = getSettings();
console.log(`\n  SuricateWEB →  http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
console.log(`  Connexion : identifiant « ${CREDS.user} » (SURICATE_USER)`);
console.log(`  Captures d'écran : ${engine.available() ? `navigateur ${chromePath()}` : 'inactives (aucun Chrome / Chromium détecté — voir CHROME_PATH)'}`);
if (CREDS.defaultedUser) console.log("  ⚠  SURICATE_USER n'est pas défini : l'identifiant par défaut « admin » est utilisé. Définissez SURICATE_USER pour le personnaliser.");
console.log(`  Telegram : ${s.telegram.token && s.telegram.chatId ? 'configuré' : 'non configuré (Réglages › Telegram)'}`);
if (process.env.SURICATE_DEMO === '1') console.log('  ⚠  MODE DÉMO : données fictives, contrôles et captures désactivés (SURICATE_DEMO=1).');
console.log('');
app.startBackground();

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    await app.stop();
    closeDb();
    process.exit(0);
  });
}
