import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Charge src/db.js dans un processus neuf, avec le dossier de données voulu.
function loadDb(dir) {
  return spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e',
    'await import(process.argv[1]); process.exit(0);', new URL('../src/db.js', import.meta.url).href],
  { env: { ...process.env, DATA_DIR: dir }, encoding: 'utf8' });
}

test('une base à l\'ancien nom (vigie.db) fait refuser le démarrage, sans créer de base vide', () => {
  const dir = mkdtempSync(join(tmpdir(), 'suricate-legacy-'));
  writeFileSync(join(dir, 'vigie.db'), '');
  const r = loadDb(dir);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Renommez-la en « suricate\.db »/);
  assert.equal(existsSync(join(dir, 'suricate.db')), false, 'aucune base vide créée en silence');
});

test('dossier de données neuf : démarrage normal ; les deux fichiers présents : suricate.db prime', () => {
  const fresh = mkdtempSync(join(tmpdir(), 'suricate-legacy-'));
  assert.equal(loadDb(fresh).status, 0);
  assert.equal(existsSync(join(fresh, 'suricate.db')), true);
  // suricate.db existe déjà (la migration a été faite) : un vieux vigie.db oublié à côté ne bloque rien.
  writeFileSync(join(fresh, 'vigie.db'), '');
  assert.equal(loadDb(fresh).status, 0);
});
