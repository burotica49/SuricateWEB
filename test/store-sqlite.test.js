// L'adaptateur SQLite respecte le contrat commun à tous les moteurs (test-support/adapter-contract.js).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openSqlite } from '../src/store/sqlite.js';
import { adapterContract } from '../test-support/adapter-contract.js';

const dirs = [];
test.after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** Un fichier neuf par test : on vérifie aussi le mode WAL et les clés étrangères réellement actifs. */
adapterContract({
  name: 'sqlite',
  open: () => {
    const dir = mkdtempSync(join(tmpdir(), 'vigie-store-'));
    dirs.push(dir);
    return openSqlite(join(dir, 'test.db'));
  },
});

test('adaptateur sqlite : clés étrangères actives, suppression en cascade', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vigie-store-'));
  dirs.push(dir);
  const db = openSqlite(join(dir, 'fk.db'));
  db.exec('CREATE TABLE p (id INTEGER PRIMARY KEY); CREATE TABLE c (id INTEGER PRIMARY KEY, p INTEGER NOT NULL REFERENCES p(id) ON DELETE CASCADE)');
  db.run('INSERT INTO p(id) VALUES(1)');
  db.run('INSERT INTO c(p) VALUES(1)');
  assert.throws(() => db.run('INSERT INTO c(p) VALUES(99)'), /FOREIGN KEY/i);
  db.run('DELETE FROM p WHERE id = 1');
  assert.equal(db.get('SELECT COUNT(*) n FROM c').n, 0);
  assert.equal(db.get('PRAGMA journal_mode').journal_mode, 'wal');
  db.close();
});

test('adaptateur sqlite : le cache d\'instructions ne grossit pas sans fin (SQL dynamique)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vigie-store-'));
  dirs.push(dir);
  const db = openSqlite(join(dir, 'cache.db'));
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
  // 1000 requêtes toutes différentes : doivent toutes réussir, même une fois le cache vidé.
  for (let i = 0; i < 1000; i++) assert.equal(db.get(`SELECT ${i} AS v FROM t UNION ALL SELECT ${i}`).v, i);
  db.close();
});
