// npm run demo : lance SuricateWeb avec des données FICTIVES (mode démo : aucun contrôle ni capture réels).
// Aucune donnée n'est écrite dans ./data : tout vit dans un dossier temporaire, supprimé à l'arrêt.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeSites } from './fake-sites.js';
import { seedDemo, DEMO_USER, DEMO_PASSWORD } from './demo-data.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = process.env.PORT || '3100';
const dataDir = mkdtempSync(join(tmpdir(), 'suricateweb-demo-'));

console.log('Préparation des données fictives…');
const fake = await startFakeSites();
await seedDemo({ dataDir, fakeSitesBase: fake.base });
await fake.close();

// Le serveur lit ses identifiants dans un .env : on lui en fournit un jetable, hors du projet.
const envFile = join(dataDir, '.env');
writeFileSync(envFile, `SURICATE_USER=${DEMO_USER}\nSURICATE_PASSWORD=${DEMO_PASSWORD}\n`);

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(ROOT, 'server.js')], {
  stdio: 'inherit',
  env: { ...process.env, DATA_DIR: dataDir, ENV_FILE: envFile, PORT, HOST: '127.0.0.1', SURICATE_DEMO: '1' },
});
console.log(`\n  Démo : http://127.0.0.1:${PORT}   identifiant « ${DEMO_USER} » · mot de passe « ${DEMO_PASSWORD} »\n  Ctrl+C pour arrêter (les données fictives sont alors supprimées).\n`);

const stop = () => { server.kill(); rmSync(dataDir, { recursive: true, force: true }); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
server.on('exit', stop);
