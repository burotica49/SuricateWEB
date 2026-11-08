// Registre du moteur de base (src/store/registry.js) : la version hébergée y branche PostgreSQL et ses migrations
// AVANT le premier import de src/db.js. Chaque cas tourne dans un processus neuf : db.js s'ouvre une seule fois par processus.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(join(ROOT, p)).href;

function run(script) {
  const dir = mkdtempSync(join(tmpdir(), 'vigie-registry-'));
  try {
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], {
      env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8', timeout: 20000,
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').pop());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('registre : un adaptateur fourni remplace SQLite, ses migrations s\'ajoutent à celles du cœur', () => {
  const out = run(`
    import { configureStore } from '${url('src/store/registry.js')}';
    import { openSqlite } from '${url('src/store/sqlite.js')}';
    let opened = null;
    configureStore({
      open: async ({ path, dataDir }) => { opened = { file: path.endsWith('vigie.db'), dataDir: dataDir === process.env.DATA_DIR }; return openSqlite(path); },
      migrations: [{ version: 2, name: 'comptes', sqlite: (db) => db.exec('CREATE TABLE cloud_accounts (id INTEGER PRIMARY KEY)'), postgres: () => {} }],
    });
    const dbm = await import('${url('src/db.js')}');
    console.log(JSON.stringify({
      opened,
      cloud: (await dbm.db.all("SELECT name FROM sqlite_master WHERE name = 'cloud_accounts'")).length,
      versions: (await dbm.db.all('SELECT version FROM schema_migrations ORDER BY version')).map((r) => r.version),
    }));
    process.exit(0);
  `);
  assert.deepEqual(out.opened, { file: true, dataDir: true }, 'l\'adaptateur reçoit le chemin du fichier et le dossier de données');
  assert.equal(out.cloud, 1, 'la migration de l\'extension a créé sa table');
  assert.deepEqual(out.versions, [1, 2]);
});

test('registre : sans configuration, SQLite dans DATA_DIR, migrations du cœur seulement', () => {
  const out = run(`
    const dbm = await import('${url('src/db.js')}');
    console.log(JSON.stringify({
      dialect: dbm.db.dialect,
      versions: (await dbm.db.all('SELECT version FROM schema_migrations ORDER BY version')).map((r) => r.version),
    }));
    process.exit(0);
  `);
  assert.deepEqual(out, { dialect: 'sqlite', versions: [1] });
});
