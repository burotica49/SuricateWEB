// Migrations de schéma : installation neuve, mise à niveau d'une installation 1.3.x, idempotence, annulation en cas d'échec.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite } from '../src/store/sqlite.js';
import { migrate } from '../src/store/migrate.js';
import { MIGRATIONS } from '../src/store/migrations/index.js';

const dirs = [];
test.after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'vigie-mig-'));
  dirs.push(dir);
  return openSqlite(join(dir, 'm.db'));
};
const tables = (db) => db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").map((r) => r.name).sort();
const columns = (db, table) => db.all(`PRAGMA table_info(${table})`).map((c) => c.name);

test('migrations : base neuve → toutes les tables, migration 1 enregistrée', async () => {
  const db = fresh();
  assert.deepEqual(await migrate(db), [1]);
  assert.deepEqual(tables(db), [
    'alerts', 'checks', 'daily_stats', 'maintenance', 'outages', 'schema_migrations', 'screenshots', 'settings', 'site_groups', 'snapshots', 'watches',
  ]);
  const rows = db.all('SELECT version, name FROM schema_migrations');
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ version: 1, name: 'initial' }]);
  // Toutes les colonnes apparues au fil des versions sont là.
  for (const c of ['next_shot', 'shot_error', 'group_id', 'position', 'next_cms']) assert.ok(columns(db, 'watches').includes(c), c);
  assert.ok(columns(db, 'screenshots').includes('final_url') && columns(db, 'screenshots').includes('page_title'));
  assert.ok(columns(db, 'alerts').includes('maintenance'));
  db.close();
});

test('migrations : rejouées, elles ne font rien', async () => {
  const db = fresh();
  await migrate(db);
  assert.deepEqual(await migrate(db), []);
  assert.equal(db.get('SELECT COUNT(*) n FROM schema_migrations').n, 1);
  db.close();
});

test('migrations : une installation 1.3.x (anciennes colonnes, sans table de suivi) est mise à niveau sans perte', async () => {
  const db = fresh();
  // Schéma de la toute première version : sans next_shot, group_id, position, next_cms, final_url, page_title, maintenance.
  db.exec(`
    CREATE TABLE watches (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, url TEXT NOT NULL, interval_min INTEGER NOT NULL DEFAULT 15,
      enabled INTEGER NOT NULL DEFAULT 1, tags TEXT NOT NULL DEFAULT '[]', config TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL, next_run INTEGER NOT NULL DEFAULT 0, last_check INTEGER, last_code INTEGER, last_ms INTEGER, last_error TEXT);
    CREATE TABLE screenshots (id INTEGER PRIMARY KEY AUTOINCREMENT, watch_id INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE, ts INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'scheduled', file TEXT NOT NULL, thumb TEXT, size INTEGER NOT NULL DEFAULT 0, width INTEGER, height INTEGER);
    CREATE TABLE alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, watch_id INTEGER NOT NULL REFERENCES watches(id) ON DELETE CASCADE, ts INTEGER NOT NULL,
      severity TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, detail TEXT, snapshot_id INTEGER, prev_snapshot_id INTEGER,
      read INTEGER NOT NULL DEFAULT 0, notified INTEGER NOT NULL DEFAULT 0, notify_error TEXT);
    INSERT INTO watches(name, url, created_at) VALUES('Un', 'https://un.test/', 1), ('Deux', 'https://deux.test/', 2);
    INSERT INTO alerts(watch_id, ts, severity, type, title) VALUES(2, 5, 'warning', 'x', 'conservée');
  `);
  assert.deepEqual(await migrate(db), [1]);
  // Les sites existants gardent leur ordre de création (position = id) et restent « sans groupe ».
  const sites = db.all('SELECT id, name, position, group_id, next_shot, next_cms FROM watches ORDER BY id').map((r) => ({ ...r }));
  assert.deepEqual(sites, [
    { id: 1, name: 'Un', position: 1, group_id: null, next_shot: 0, next_cms: 0 },
    { id: 2, name: 'Deux', position: 2, group_id: null, next_shot: 0, next_cms: 0 },
  ]);
  assert.equal(db.get('SELECT title, maintenance FROM alerts').title, 'conservée');
  assert.equal(db.get('SELECT maintenance FROM alerts').maintenance, 0);
  assert.ok(tables(db).includes('maintenance') && tables(db).includes('outages'));
  db.close();
});

test('migrations : appliquées dans l\'ordre, une seule fois, et annulées entièrement en cas d\'échec', async () => {
  const db = fresh();
  const calls = [];
  const set = [
    { version: 2, name: 'deux', sqlite: async (d) => { calls.push(2); await d.exec('CREATE TABLE deux (id INTEGER)'); } },
    { version: 1, name: 'un', sqlite: async (d) => { calls.push(1); await d.exec('CREATE TABLE un (id INTEGER)'); } },
  ];
  assert.deepEqual(await migrate(db, set), [1, 2]);
  assert.deepEqual(calls, [1, 2]);
  assert.deepEqual(await migrate(db, set), []);

  const failing = [...set, { version: 3, name: 'casse', sqlite: async (d) => { await d.exec('CREATE TABLE trois (id INTEGER)'); throw new Error('migration cassée'); } }];
  await assert.rejects(() => migrate(db, failing), /migration cassée/);
  assert.ok(!tables(db).includes('trois'), 'le DDL de la migration en échec est annulé');
  assert.deepEqual(db.all('SELECT version FROM schema_migrations ORDER BY version').map((r) => r.version), [1, 2]);
  db.close();
});

test('migrations : version en double ou moteur non prévu → refus explicite', async () => {
  const db = fresh();
  await assert.rejects(() => migrate(db, [{ version: 1, name: 'a', sqlite() {} }, { version: 1, name: 'b', sqlite() {} }]), /double/);
  await assert.rejects(() => migrate(db, [{ version: 9, name: 'seulement-pg', postgres() {} }]), /pas de version « sqlite »/);
  db.close();
});

test('migrations : chaque migration publiée existe pour SQLite ET PostgreSQL', () => {
  for (const m of MIGRATIONS) {
    assert.equal(typeof m.sqlite, 'function', `migration ${m.version} : version SQLite`);
    assert.equal(typeof m.postgres, 'function', `migration ${m.version} : version PostgreSQL`);
  }
  assert.deepEqual(MIGRATIONS.map((m) => m.version), MIGRATIONS.map((_, i) => i + 1), 'numéros consécutifs à partir de 1');
});
